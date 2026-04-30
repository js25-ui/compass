import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface SecTickerEntry {
  cik: string;        // zero-padded to 10 digits, e.g. "0000320193"
  ticker: string;     // upper-cased, e.g. "AAPL"
  name: string;       // canonical SEC name, e.g. "Apple Inc."
}

interface RawEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

let byTicker: Map<string, SecTickerEntry> | null = null;
let byCik: Map<string, SecTickerEntry> | null = null;
let byNormalizedName: Map<string, SecTickerEntry> | null = null;
let allEntries: SecTickerEntry[] | null = null;

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(inc|corp|corporation|co|company|llc|ltd|plc|sa|nv|ag|holdings|holding|group|the|adr)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function padCik(cik: number | string): string {
  return String(cik).padStart(10, '0');
}

async function load(): Promise<void> {
  if (byTicker) return;
  const path = resolve(process.cwd(), 'data', 'sec-tickers.json');
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, RawEntry>;

  const t = new Map<string, SecTickerEntry>();
  const c = new Map<string, SecTickerEntry>();
  const n = new Map<string, SecTickerEntry>();
  const all: SecTickerEntry[] = [];

  for (const raw of Object.values(parsed)) {
    const entry: SecTickerEntry = {
      cik: padCik(raw.cik_str),
      ticker: raw.ticker.toUpperCase(),
      name: raw.title,
    };
    t.set(entry.ticker, entry);
    c.set(entry.cik, entry);
    n.set(normalizeName(entry.name), entry);
    all.push(entry);
  }

  byTicker = t;
  byCik = c;
  byNormalizedName = n;
  allEntries = all;
}

export async function findByTicker(ticker: string): Promise<SecTickerEntry | null> {
  await load();
  return byTicker!.get(ticker.toUpperCase().replace(/^\$/, '')) ?? null;
}

export async function findByCik(cik: string): Promise<SecTickerEntry | null> {
  await load();
  return byCik!.get(padCik(cik)) ?? null;
}

/** Common stock tickers have no class suffix — prefer them over BA-PA, GOOG vs GOOGL, etc. */
function isCommonStock(entry: SecTickerEntry): boolean {
  return !/[.\-]/.test(entry.ticker);
}

function pickBest(candidates: SecTickerEntry[]): SecTickerEntry {
  const common = candidates.filter(isCommonStock);
  if (common.length > 0) return common.sort((a, b) => a.ticker.length - b.ticker.length)[0];
  return candidates.sort((a, b) => a.name.length - b.name.length)[0];
}

export async function findByName(query: string): Promise<SecTickerEntry | null> {
  await load();
  const normalized = normalizeName(query);
  if (!normalized) return null;

  const exactMatches = allEntries!.filter(e => normalizeName(e.name) === normalized);
  if (exactMatches.length > 0) return pickBest(exactMatches);

  const prefixMatches = allEntries!.filter(e => normalizeName(e.name).startsWith(normalized));
  if (prefixMatches.length > 0) return pickBest(prefixMatches);

  const containsMatches = allEntries!.filter(e => {
    const en = normalizeName(e.name);
    return en.includes(` ${normalized} `) || en.startsWith(`${normalized} `) || en.endsWith(` ${normalized}`);
  });
  if (containsMatches.length > 0) return pickBest(containsMatches);

  return null;
}

export async function totalEntries(): Promise<number> {
  await load();
  return allEntries!.length;
}
