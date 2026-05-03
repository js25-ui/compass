/**
 * Financial-facts cache.
 *
 * Read/write facts keyed by (target_id, metric, period). The XBRL parser
 * upserts into this table; pre-flight checks read from it. Models never
 * re-parse 10-Ks — they read from here.
 */

import { getSupabaseService } from '@/lib/db/client';
import { getAnnualFinancials } from '@/lib/retrieval/xbrl';

export type FactMetric =
  | 'revenue'
  | 'ebitda'
  | 'operating_income'
  | 'net_income'
  | 'gross_profit'
  | 'capex'
  | 'long_term_debt'
  | 'total_assets'
  | 'total_liabilities'
  | 'cash_and_equivalents'
  | 'shares_outstanding';

export interface FinancialFact {
  metric: FactMetric;
  value: number | null;
  period: string;                  // 'FY2024', 'LTM', 'Q1_2026', etc.
  sourceFilingId?: string | null;
  filedAt?: string | null;
}

interface Row {
  id: string;
  target_id: string;
  metric: string;
  value: number | null;
  period: string | null;
  source_filing_id: string | null;
  filed_at: string | null;
}

export async function getFactsForTarget(targetId: string): Promise<FinancialFact[]> {
  const sb = getSupabaseService();
  const { data, error } = await sb
    .from('financial_facts')
    .select('id, target_id, metric, value, period, source_filing_id, filed_at')
    .eq('target_id', targetId)
    .order('filed_at', { ascending: false });
  if (error) throw new Error(`financial_facts read failed: ${error.message}`);
  return ((data ?? []) as Row[]).map(r => ({
    metric: r.metric as FactMetric,
    value: r.value,
    period: r.period ?? 'unknown',
    sourceFilingId: r.source_filing_id,
    filedAt: r.filed_at,
  }));
}

/** Return latest non-null value for a metric (any period). */
export function pickLatest(facts: FinancialFact[], metric: FactMetric): FinancialFact | null {
  for (const f of facts) {
    if (f.metric === metric && f.value != null && Number.isFinite(f.value)) return f;
  }
  return null;
}

/** Return latest annual (FY*) fact for a metric. */
export function pickLatestAnnual(facts: FinancialFact[], metric: FactMetric): FinancialFact | null {
  for (const f of facts) {
    if (f.metric === metric && /^FY\d{4}$/.test(f.period) && f.value != null && Number.isFinite(f.value)) return f;
  }
  return pickLatest(facts, metric);
}

/** Get a small history (n latest annual values) for trend/CAGR calculations. */
export function pickAnnualHistory(facts: FinancialFact[], metric: FactMetric, count: number): FinancialFact[] {
  const annual = facts.filter(
    f => f.metric === metric && /^FY\d{4}$/.test(f.period) && f.value != null && Number.isFinite(f.value),
  );
  // facts are returned newest-first by filed_at, but a fiscal year may be
  // reported in multiple filings (10-K, 10-Q with restatement). De-dup by
  // period taking the first (most recently filed).
  const seen = new Set<string>();
  const dedup: FinancialFact[] = [];
  for (const f of annual) {
    if (seen.has(f.period)) continue;
    seen.add(f.period);
    dedup.push(f);
  }
  // Sort by FY descending so [0] is the most recent fiscal year.
  dedup.sort((a, b) => (a.period < b.period ? 1 : -1));
  return dedup.slice(0, count);
}

interface UpsertInput {
  target_id: string;
  metric: FactMetric;
  value: number | null;
  period: string;
  source_filing_id?: string | null;
  filed_at?: string | null;
}

export async function upsertFacts(rows: UpsertInput[]): Promise<void> {
  if (rows.length === 0) return;
  const sb = getSupabaseService();
  const { error } = await sb
    .from('financial_facts')
    .upsert(rows, { onConflict: 'target_id,metric,period' });
  if (error) throw new Error(`financial_facts upsert failed: ${error.message}`);
}

/**
 * Pull XBRL annual financials for a CIK and seed the cache. Idempotent —
 * upsert on (target_id, metric, period). Returns the number of facts written.
 */
export async function seedFromXbrl(targetId: string, cik: string): Promise<number> {
  const annuals = await getAnnualFinancials(cik);
  if (annuals.length === 0) return 0;

  const rows: UpsertInput[] = [];
  for (const a of annuals) {
    const period = `FY${a.fy}`;
    const filed = a.source.filed;
    const accn = a.source.accn;
    push(rows, targetId, 'revenue', a.revenue, period, filed, accn);
    push(rows, targetId, 'net_income', a.netIncome, period, filed, accn);
    push(rows, targetId, 'operating_income', a.operatingIncome, period, filed, accn);
    push(rows, targetId, 'gross_profit', a.grossProfit, period, filed, accn);
    push(rows, targetId, 'total_assets', a.totalAssets, period, filed, accn);
    push(rows, targetId, 'total_liabilities', a.totalLiabilities, period, filed, accn);
    push(rows, targetId, 'cash_and_equivalents', a.cashAndEquivalents, period, filed, accn);
    push(rows, targetId, 'long_term_debt', a.longTermDebt, period, filed, accn);

    // Derive EBITDA from operating income when available (proxy without
    // D&A breakout, but a reasonable lower-bound). Not perfect but better
    // than null.
    if (a.operatingIncome != null) {
      push(rows, targetId, 'ebitda', a.operatingIncome, period, filed, accn);
    }
  }

  // Also publish "latest annual" duplicates with period='LTM' to make
  // simple lookups easy. We pick the newest fiscal year only.
  const newest = annuals[annuals.length - 1];
  if (newest) {
    const period = 'LTM';
    const filed = newest.source.filed;
    const accn = newest.source.accn;
    push(rows, targetId, 'revenue', newest.revenue, period, filed, accn);
    push(rows, targetId, 'net_income', newest.netIncome, period, filed, accn);
    push(rows, targetId, 'operating_income', newest.operatingIncome, period, filed, accn);
    push(rows, targetId, 'gross_profit', newest.grossProfit, period, filed, accn);
    push(rows, targetId, 'long_term_debt', newest.longTermDebt, period, filed, accn);
    if (newest.operatingIncome != null) {
      push(rows, targetId, 'ebitda', newest.operatingIncome, period, filed, accn);
    }
  }

  await upsertFacts(rows);
  return rows.length;
}

function push(
  rows: UpsertInput[],
  target_id: string,
  metric: FactMetric,
  value: number | null,
  period: string,
  filed_at: string | null,
  accn: string | null,
): void {
  if (value == null || !Number.isFinite(value)) return;     // never store NaN/null
  // Convert to $M for consistency. Anything that comes from XBRL is in raw $.
  const valueM = value / 1_000_000;
  rows.push({ target_id, metric, value: valueM, period, filed_at, source_filing_id: accn });
}
