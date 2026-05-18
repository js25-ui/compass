/**
 * Sector screening: phrase → constituent list → rank by XBRL LTM revenue.
 *
 * Two-stage lookup:
 *  1. Normalize the user's sector phrase ("largest REITs", "biggest data
 *     center companies") and match it against label aliases in
 *     data/sector_constituents.json. Returns a curated constituent ticker
 *     list per sector — much faster than crawling SEC's full company
 *     universe by SIC code, and produces deterministic results.
 *  2. For each constituent ticker, resolve to CIK + fetch LTM revenue via
 *     the existing xbrl_ltm helper (same path trading comps uses). Sort
 *     descending, take top N.
 *
 * Falls back to EDGAR search (via the same helper that recovered CFLT
 * for trading comps) when a ticker isn't in company_tickers.json.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { findByTicker } from '@/lib/lookup/sec_tickers';
import { findCikByTickerViaEdgarSearch } from '@/lib/lookup/edgar_search';
import { getLtmFinancials } from './xbrl_ltm';

export interface SectorMatch {
  sectorKey: string;
  description: string;
  sicCodes: string[];
  constituents: string[];
}

interface SectorConfigEntry {
  labels: string[];
  sic_codes: string[];
  description: string;
  constituents: string[];
}

interface SectorConfig {
  sectors: Record<string, SectorConfigEntry>;
}

let cached: SectorConfig | null = null;

async function loadConfig(): Promise<SectorConfig> {
  if (cached) return cached;
  const path = resolve(process.cwd(), 'data', 'sector_constituents.json');
  const raw = await readFile(path, 'utf8');
  cached = JSON.parse(raw) as SectorConfig;
  return cached;
}

function normalizePhrase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(largest|biggest|top|major|leading|us|publicly traded|public|the|in|are|what|key|companies|company|stocks?)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Try to match `phrase` against a configured sector. Returns the matched
 * sector entry or null when no match is found. Match order: exact label,
 * then substring on either side (label contains phrase, or phrase
 * contains label) — the broader form catches "largest REITs in the US"
 * matching the "reits" label.
 */
export async function matchSector(phrase: string): Promise<SectorMatch | null> {
  if (!phrase || !phrase.trim()) return null;
  const cfg = await loadConfig();
  const norm = normalizePhrase(phrase);
  if (!norm) return null;

  // Exact match against any label (also normalized).
  for (const [key, entry] of Object.entries(cfg.sectors)) {
    for (const label of entry.labels) {
      if (normalizePhrase(label) === norm) {
        return { sectorKey: key, description: entry.description, sicCodes: entry.sic_codes, constituents: entry.constituents };
      }
    }
  }
  // Substring match — prefer the LONGEST label that the phrase contains.
  let bestMatch: { entry: SectorConfigEntry; key: string; labelLen: number } | null = null;
  for (const [key, entry] of Object.entries(cfg.sectors)) {
    for (const label of entry.labels) {
      const normLabel = normalizePhrase(label);
      if (!normLabel) continue;
      if (norm.includes(normLabel) || normLabel.includes(norm)) {
        if (!bestMatch || normLabel.length > bestMatch.labelLen) {
          bestMatch = { entry, key, labelLen: normLabel.length };
        }
      }
    }
  }
  if (bestMatch) {
    return {
      sectorKey: bestMatch.key,
      description: bestMatch.entry.description,
      sicCodes: bestMatch.entry.sic_codes,
      constituents: bestMatch.entry.constituents,
    };
  }
  return null;
}

/** Diagnostic: list every configured sector key (for refusal cards). */
export async function listSectors(): Promise<Array<{ key: string; description: string; aliases: string[] }>> {
  const cfg = await loadConfig();
  return Object.entries(cfg.sectors).map(([key, entry]) => ({
    key,
    description: entry.description,
    aliases: entry.labels.slice(0, 4),
  }));
}

export interface RankedConstituent {
  ticker: string;
  cik: string;
  name: string;
  ltmRevenueM: number;
  ltmRevenueGrowthPct: number | null;
  ltmOperatingIncomeM: number | null;
  ltmAdjustedEbitdaM: number | null;
  periodEnd: string | null;
  latestFilingDate: string | null;
}

/**
 * Resolve each constituent ticker → CIK, pull LTM revenue, sort
 * descending, return top N. Drops constituents whose XBRL fetch returns
 * no revenue (delisted, non-US ADR, foreign filer with different tags).
 */
export async function rankConstituentsByLtmRevenue(
  tickers: string[],
  topN: number,
  onProgress?: (msg: string) => void,
): Promise<{ ranked: RankedConstituent[]; dropped: Array<{ ticker: string; reason: string }> }> {
  const dropped: Array<{ ticker: string; reason: string }> = [];
  const fetched: RankedConstituent[] = [];

  // Modest concurrency cap — keep SEC happy and don't burst XBRL fetches.
  const CONCURRENCY = 4;
  let next = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= tickers.length) return;
      const raw = tickers[i];
      const ticker = raw.toUpperCase();

      let cik: string | null = null;
      let name = ticker;
      const local = await findByTicker(ticker);
      if (local) {
        cik = local.cik;
        name = local.name;
      } else {
        const remote = await findCikByTickerViaEdgarSearch(ticker);
        if (remote) {
          cik = remote.cik;
          name = remote.name;
        }
      }
      if (!cik) {
        dropped.push({ ticker, reason: 'ticker not resolved via SEC registry or EDGAR search' });
        completed++;
        if (onProgress) onProgress(`Screened ${completed}/${tickers.length} constituents…`);
        continue;
      }

      try {
        const ltm = await getLtmFinancials(cik);
        if (!ltm || ltm.ltmRevenue == null) {
          dropped.push({ ticker, reason: 'XBRL returned no LTM revenue' });
        } else {
          fetched.push({
            ticker,
            cik,
            name,
            ltmRevenueM: ltm.ltmRevenue,
            ltmRevenueGrowthPct: ltm.ltmRevenueGrowthPct,
            ltmOperatingIncomeM: ltm.ltmOperatingIncome,
            ltmAdjustedEbitdaM: ltm.ltmAdjustedEbitda,
            periodEnd: ltm.periodEnd,
            latestFilingDate: ltm.latestFilingDate,
          });
        }
      } catch (err) {
        dropped.push({ ticker, reason: `XBRL fetch threw: ${(err as Error).message.slice(0, 60)}` });
      }
      completed++;
      if (onProgress) onProgress(`Screened ${completed}/${tickers.length} constituents…`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, () => worker()));

  fetched.sort((a, b) => b.ltmRevenueM - a.ltmRevenueM);
  return { ranked: fetched.slice(0, topN), dropped };
}
