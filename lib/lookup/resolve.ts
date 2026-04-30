import 'server-only';
import { findByCik, findByName, findByTicker, type SecTickerEntry } from './sec_tickers';
import { matchCurated, type CuratedEntity } from './curated';
import type { EntityType } from '@/lib/db/types';

export type ResolutionSource = 'ticker' | 'cik' | 'sec_name' | 'curated' | 'llm';

export interface ResolvedEntity {
  /** Stable target id used in the targets table. */
  id: string;
  /** Canonical display name. */
  name: string;
  ticker?: string;
  cik?: string;
  entity_type: EntityType;
  business_line_guess?: 'ecm' | 'dcm' | 'alts';
  source: ResolutionSource;
  confidence: number;
}

const TICKER_PATTERN = /^\$?[A-Z][A-Z.\-]{0,5}$/;
const CIK_PATTERN = /^\d{1,10}$/;

function targetIdForSec(entry: SecTickerEntry): string {
  return `cik-${entry.cik}`;
}

function entryToResolved(
  entry: SecTickerEntry,
  source: ResolutionSource,
  confidence: number,
): ResolvedEntity {
  return {
    id: targetIdForSec(entry),
    name: entry.name,
    ticker: entry.ticker,
    cik: entry.cik,
    entity_type: 'public_company',
    source,
    confidence,
  };
}

function curatedToResolved(entity: CuratedEntity): ResolvedEntity {
  return {
    id: entity.id,
    name: entity.name,
    entity_type: entity.entity_type,
    business_line_guess: entity.business_line_guess,
    source: 'curated',
    confidence: 0.95,
  };
}

/**
 * Resolve a free-form query string to a single canonical entity.
 * Returns null when no deterministic match is possible — caller can fall back
 * to an LLM extractor (Phase 3) or surface a "couldn't resolve" message.
 */
export async function resolveEntity(query: string): Promise<ResolvedEntity | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  // 1. Pure CIK
  if (CIK_PATTERN.test(trimmed)) {
    const byCik = await findByCik(trimmed);
    if (byCik) return entryToResolved(byCik, 'cik', 1);
  }

  // 2. Ticker pattern (uppercase, 1-6 chars, optional $ prefix)
  if (TICKER_PATTERN.test(trimmed)) {
    const stripped = trimmed.replace(/^\$/, '').toUpperCase();
    const byTicker = await findByTicker(stripped);
    if (byTicker) return entryToResolved(byTicker, 'ticker', 1);
  }

  // 3. Mixed-case ticker like "aapl"
  if (trimmed.length <= 6 && /^[A-Za-z]+$/.test(trimmed)) {
    const byTicker = await findByTicker(trimmed.toUpperCase());
    if (byTicker) return entryToResolved(byTicker, 'ticker', 0.9);
  }

  // 4. Curated (sovereigns, munis, well-known privates)
  const curated = matchCurated(trimmed);
  if (curated) return curatedToResolved(curated);

  // 5. SEC name match
  const byName = await findByName(trimmed);
  if (byName) return entryToResolved(byName, 'sec_name', 0.85);

  // 6. Punt — caller falls back to LLM extractor or surfaces "no match"
  return null;
}
