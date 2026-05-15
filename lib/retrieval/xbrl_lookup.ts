/**
 * XBRL fact lookup — returns specific numerical metrics for a target
 * directly from the financial_facts table (populated from SEC EDGAR
 * companyfacts API at ingest time). For hard-number questions like
 * "what was Snowflake's revenue in FY2026", this is more reliable than
 * vector retrieval over chunk text because the values are pulled from
 * canonical XBRL tags rather than parsed prose.
 */

import { getFactsForTarget, pickAnnualHistory, type FactMetric, type FinancialFact } from '@/lib/data/financial_facts';

const METRIC_LABELS: Record<FactMetric, string> = {
  revenue: 'Revenue',
  ebitda: 'EBITDA (proxied from operating income)',
  operating_income: 'Operating income',
  net_income: 'Net income',
  gross_profit: 'Gross profit',
  capex: 'Capex',
  long_term_debt: 'Long-term debt',
  total_assets: 'Total assets',
  total_liabilities: 'Total liabilities',
  cash_and_equivalents: 'Cash and equivalents',
  shares_outstanding: 'Shares outstanding',
};

export interface XbrlFactValue {
  metric: FactMetric;
  label: string;
  /** Up to N periods, newest first. */
  history: Array<{ period: string; value: number; filedAt: string | null }>;
}

export interface XbrlLookupResult {
  targetId: string;
  values: XbrlFactValue[];
  /** Metrics the caller asked for that weren't present in financial_facts. */
  missing: string[];
}

/**
 * Pull the requested metrics for a target from financial_facts. The chat
 * agent uses this when the user asks about specific quantitative metrics
 * — it surfaces XBRL-derived values directly, without depending on the
 * chunk re-ranker to find the income statement table.
 *
 * Returns up to `periodsBack` periods per metric (default 3 fiscal years).
 */
export async function lookupXbrlFacts(opts: {
  targetId: string;
  metrics: string[];
  periodsBack?: number;
}): Promise<XbrlLookupResult> {
  const periodsBack = opts.periodsBack ?? 3;
  let facts: FinancialFact[];
  try {
    facts = await getFactsForTarget(opts.targetId);
  } catch {
    return { targetId: opts.targetId, values: [], missing: opts.metrics };
  }

  const values: XbrlFactValue[] = [];
  const missing: string[] = [];
  for (const m of opts.metrics) {
    if (!isFactMetric(m)) {
      missing.push(m);
      continue;
    }
    const history = pickAnnualHistory(facts, m, periodsBack);
    if (history.length === 0) {
      missing.push(m);
      continue;
    }
    values.push({
      metric: m,
      label: METRIC_LABELS[m],
      history: history.map(h => ({
        period: h.period,
        value: h.value!,
        filedAt: h.filedAt ?? null,
      })),
    });
  }
  return { targetId: opts.targetId, values, missing };
}

function isFactMetric(m: string): m is FactMetric {
  return Object.prototype.hasOwnProperty.call(METRIC_LABELS, m);
}

/**
 * Pre-formatted summary string suitable for injection into a Sonnet
 * system prompt: 'XBRL facts for <target>: revenue FY2026 $X.XB, FY2025
 * $Y.YB; net_income FY2026 $A.AB, FY2025 $B.BB; ...'. The chat agent
 * adds this when the query mentions quantitative metrics and the
 * pinned target has XBRL data — gives Sonnet the actual numbers to
 * cite without needing a tool call.
 */
export function summarizeFactsForPrompt(targetName: string, result: XbrlLookupResult): string {
  if (result.values.length === 0) return '';
  const lines: string[] = [`XBRL FACTS — ${targetName} (sourced from SEC EDGAR companyfacts, $M unless noted):`];
  for (const v of result.values) {
    const hist = v.history
      .map(h => `${h.period} ${formatMoneyM(h.value, v.metric)}`)
      .join(', ');
    lines.push(`- ${v.label}: ${hist}`);
  }
  if (result.missing.length > 0) {
    lines.push(`Not in XBRL cache: ${result.missing.join(', ')}.`);
  }
  return lines.join('\n');
}

function formatMoneyM(value: number, metric: FactMetric): string {
  if (metric === 'shares_outstanding') {
    return `${(value / 1).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }
  // Values in financial_facts are stored in $M.
  const abs = Math.abs(value);
  if (abs >= 1000) return `$${(value / 1000).toFixed(2)}B`;
  if (abs >= 1)    return `$${Math.round(value).toLocaleString()}M`;
  return `$${value.toFixed(2)}M`;
}
