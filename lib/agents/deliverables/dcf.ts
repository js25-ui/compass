/**
 * DCF Valuation deliverable.
 *
 * Takes historical revenue + operating-income series from XBRL, projects
 * unlevered FCF over the user-chosen horizon, discounts at WACC, and
 * computes terminal value via Gordon Growth (default) or an exit multiple.
 *
 * Math is intentionally simple — this is a sponsor-grade quick valuation,
 * not a fully-detailed three-statement build:
 *   FCF_t  = EBIT_t × (1 - tax_rate) - capex_t
 *   EV     = Σ FCF_t / (1 + WACC)^t  +  TV / (1 + WACC)^N
 *   TV (Gordon) = FCF_N × (1 + g) / (WACC - g)
 *   TV (Exit)   = EBITDA_N × exit_multiple
 *
 * Anything that would require us to fabricate (current share price,
 * net debt, beta, etc.) is omitted — we report enterprise value and
 * an EV/Revenue, EV/EBIT crosscheck rather than per-share targets.
 */

import {
  escape,
  fmtMillions,
  fmtMultiple,
  fmtPctRaw,
  table,
  type DeliverableEvent,
  type InputTrace,
} from './shared';
import { preflight } from '@/lib/data/preflight';
import { DCF_MANIFEST as DCF_DATA_MANIFEST } from '@/lib/models/manifests';
import { pickAnnualHistory } from '@/lib/data/financial_facts';
import { runDCF, DCFComputeError, type DCFInputs, type DCFResult } from '@/lib/models/dcf';
import { getLtmFinancials } from '@/lib/retrieval/xbrl_ltm';

export interface DCFScope {
  projection_years?: string | number;
  wacc_method?: 'computed' | 'manual';
  discount_rate?: number;        // % — used when wacc_method = manual
  terminal_growth_rate?: number; // %
  terminal_method?: 'gordon_growth' | 'exit_multiple';
  exit_multiple?: number;        // x EBITDA — used when terminal_method = exit_multiple
  tax_rate?: number;             // %
  /** User-supplied projection drivers — override historical-derived defaults. */
  revenue_cagr?: number;         // % flat CAGR
  ebit_margin?: number;          // % held flat across forecast
  capex_pct_revenue?: number;    // %
  nwc_pct_revenue?: number;      // % of incremental revenue
  [k: string]: unknown;
}

/** Pipeline carries the XBRL period in the baseYear cell; the pure DCFResult
 *  doesn't know about filing periods. We add the period back when rendering. */
type DCFResultWithPeriod = DCFResult & { baseYear: DCFResult['baseYear'] & { period: string } };

const DEFAULT_COMPUTED_WACC_PCT = 9.0;     // placeholder until we plug CAPM

export async function* runDCFPipeline(opts: {
  query: string;
  scope: DCFScope;
  detectedTarget?: { name: string; ticker?: string } | null;
}): AsyncGenerator<DeliverableEvent, void> {
  const target = opts.detectedTarget?.name ?? opts.query;
  yield { type: 'progress', step: `Pre-flight: gathering ${target} financials…` };

  const pre = await preflight({
    query: opts.query,
    detectedTarget: opts.detectedTarget,
    manifest: DCF_DATA_MANIFEST,
  });

  if (!pre.ok) {
    yield {
      type: 'token',
      text: renderPreflightFailureHtml(pre, target),
    };
    yield { type: 'done' };
    return;
  }

  const revenueHist = pre.facts['revenue'];
  const oiHist = pre.facts['operating_income'];
  const capexHist = pre.facts['capex'] ?? null;

  if (!Array.isArray(revenueHist) || revenueHist.length < 2 ||
      !Array.isArray(oiHist) || oiHist.length < 2) {
    yield {
      type: 'token',
      text: refusalCard(target, 'Insufficient historical data', `Compass needs ≥2 years of revenue + operating income to project forward. Found ${Array.isArray(revenueHist) ? revenueHist.length : 0}y revenue / ${Array.isArray(oiHist) ? oiHist.length : 0}y operating income.`),
    };
    yield { type: 'done' };
    return;
  }

  // Sort newest-first; pickAnnualHistory already does this but be defensive.
  const revenue = pickAnnualHistory(revenueHist, 'revenue', 5);
  const oi = pickAnnualHistory(oiHist, 'operating_income', 5);
  const capex = Array.isArray(capexHist) ? pickAnnualHistory(capexHist, 'capex', 3) : [];

  yield {
    type: 'progress',
    step: `Pulled ${revenue.length}y revenue · ${oi.length}y EBIT${capex.length > 0 ? ` · ${capex.length}y capex` : ''}`,
  };

  // Base-year scalars (latest fiscal year) — historical anchors. Each can
  // be overridden by a user-supplied scope value below.
  const baseRevenue = revenue[0].value!;
  const baseEbit = oi[0].value!;
  const histEbitMargin = baseEbit / baseRevenue;
  const histCapexPctRevenue = capex.length > 0 && capex[0].value != null
    ? capex[0].value / baseRevenue
    : 0.04;

  // Pull D&A from XBRL (DepreciationDepletionAndAmortization concept).
  // financial_facts doesn't cache D&A yet, so fetch direct from
  // companyfacts via the LTM helper — its FY-when-fresh logic returns
  // the same fiscal year as the revenue/EBIT we just used.
  const ltm = pre.entity.cik ? await getLtmFinancials(pre.entity.cik).catch(() => null) : null;
  const histDaPctRevenue = ltm?.ltmDepreciationAmortization != null && ltm.ltmRevenue && ltm.ltmRevenue > 0
    ? ltm.ltmDepreciationAmortization / ltm.ltmRevenue
    : 0.025;  // 2.5% is a reasonable cross-sector software/large-cap default

  // Historical CAGR — oldest annual to latest annual.
  const oldestRevenue = revenue[revenue.length - 1].value!;
  const yearsSpan = revenue.length - 1;
  const historicalCagr = yearsSpan > 0
    ? Math.pow(baseRevenue / oldestRevenue, 1 / yearsSpan) - 1
    : 0;

  // Resolve scope-driven parameters. Use toPct() instead of raw Number(...)
  // so the pipeline tolerates string inputs ("16", "16%", " 16.0 ") that
  // can arrive when a value round-trips through form submission, JSON, or
  // an LLM-extracted scope. A silent NaN→default fallback here was the
  // root-cause class behind every "user said X, model used default" audit
  // finding to date.
  const projectionYears = toPct(opts.scope.projection_years, 5);
  const waccMethod = opts.scope.wacc_method ?? 'computed';
  const waccPct = waccMethod === 'manual' && opts.scope.discount_rate != null
    ? toPct(opts.scope.discount_rate, DEFAULT_COMPUTED_WACC_PCT)
    : DEFAULT_COMPUTED_WACC_PCT;
  const wacc = waccPct / 100;
  const terminalGrowthPct = toPct(opts.scope.terminal_growth_rate, 2.5);
  const g = terminalGrowthPct / 100;
  const taxRatePct = toPct(opts.scope.tax_rate, 25);
  const terminalMethod = (opts.scope.terminal_method ?? 'gordon_growth') as 'gordon_growth' | 'exit_multiple';
  const exitMultiple = opts.scope.exit_multiple != null ? toPct(opts.scope.exit_multiple, 10) : null;

  // User-supplied projection drivers (% inputs). When set, override historical.
  const projectedRevenueCagr = opts.scope.revenue_cagr != null ? toPct(opts.scope.revenue_cagr, 0) / 100 : undefined;
  const baseEbitMargin = opts.scope.ebit_margin != null ? toPct(opts.scope.ebit_margin, histEbitMargin * 100) / 100 : histEbitMargin;
  const baseCapexPctRevenue = opts.scope.capex_pct_revenue != null ? toPct(opts.scope.capex_pct_revenue, histCapexPctRevenue * 100) / 100 : histCapexPctRevenue;
  const nwcPctIncrementalRevenue = opts.scope.nwc_pct_revenue != null ? toPct(opts.scope.nwc_pct_revenue, 0) / 100 : 0;
  const baseDaPctRevenue = histDaPctRevenue;

  yield {
    type: 'progress',
    step: `Projecting ${projectionYears}y · ${projectedRevenueCagr != null ? `${(projectedRevenueCagr*100).toFixed(1)}% rev CAGR (user)` : `historical CAGR ${(historicalCagr*100).toFixed(1)}%`} · ${(baseEbitMargin*100).toFixed(1)}% EBIT mgn · WACC ${waccPct.toFixed(2)}% · g ${terminalGrowthPct.toFixed(2)}%`,
  };

  const dcfInputs: DCFInputs = {
    baseRevenue,
    baseEbit,
    baseEbitMargin,
    baseCapexPctRevenue,
    baseDaPctRevenue,
    nwcPctIncrementalRevenue,
    historicalCagr,
    projectedRevenueCagr,
    projectionYears,
    waccPct,
    terminalGrowthPct,
    taxRatePct,
    terminalMethod,
    exitMultiple,
  };
  // Emit inputs_resolved so the chat route can buffer these and re-emit
  // deliverable_context with _model_* keys — letting Monte Carlo / Excel
  // overlays carry forward exactly what this DCF ran on.
  yield { type: 'inputs_resolved', inputs: dcfInputs as unknown as Record<string, unknown> };

  let pureResult: DCFResult;
  try {
    pureResult = runDCF(dcfInputs);
  } catch (err) {
    if (err instanceof DCFComputeError && err.field === 'terminal_growth_rate') {
      yield {
        type: 'token',
        text: refusalCard(target, 'Gordon Growth divergence',
          `Terminal growth ${terminalGrowthPct.toFixed(1)}% ≥ WACC ${waccPct.toFixed(1)}%. Gordon Growth requires g < WACC. Lower terminal growth or raise WACC and re-run.`),
      };
      yield { type: 'done' };
      return;
    }
    yield { type: 'error', error: err instanceof Error ? err.message : 'DCF compute failed' };
    yield { type: 'done' };
    return;
  }

  const result: DCFResultWithPeriod = {
    ...pureResult,
    baseYear: { ...pureResult.baseYear, period: revenue[0].period },
  };
  const { enterpriseValue, terminalValue, pvTerminal, projections } = pureResult;

  yield {
    type: 'progress',
    step: `Inputs resolved: ${fmtPctRaw(result.inputs.waccPct, 2)} WACC · ${fmtPctRaw(result.inputs.terminalGrowthPct, 2)} g · base ${fmtMillions(result.baseYear.revenue)} revenue`,
  };

  // Source anchor — every base-year scalar derives from this XBRL row.
  const sources = [
    {
      n: 1,
      title: `${pre.entity.name} ${revenue[0].period} financials`,
      url: pre.entity.cik
        ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${pre.entity.cik}&type=10-K`
        : null,
      meta: `SEC EDGAR · XBRL company facts · ${revenue.length}y revenue + ${oi.length}y operating income`,
    },
  ];
  yield { type: 'sources', sources };

  const xbrlRef = `SEC EDGAR · XBRL · ${revenue[0].period}`;
  const userSpec = (k: keyof DCFScope) => opts.scope[k] != null;
  const fromPrompt = (k: keyof DCFScope) => userSpec(k) ? 'from your prompt' : null;
  const inputs: InputTrace[] = [
    { field: 'target', label: 'Target entity', value: `${pre.entity.name}${pre.entity.ticker ? ` (${pre.entity.ticker})` : ''}`, origin: 'sourced', sourceRef: pre.entity.cik ? `SEC EDGAR · CIK ${pre.entity.cik}` : 'Curated entity', citationN: 1 },
    { field: 'base_revenue', label: 'Base-year revenue', value: fmtMillions(baseRevenue), origin: 'sourced', sourceRef: xbrlRef, citationN: 1 },
    { field: 'base_ebit', label: 'Base-year EBIT', value: fmtMillions(baseEbit), origin: 'sourced', sourceRef: xbrlRef, citationN: 1 },
    {
      field: 'revenue_cagr',
      label: 'Projected revenue CAGR',
      value: projectedRevenueCagr != null ? `${(projectedRevenueCagr * 100).toFixed(2)}%` : `${(historicalCagr * 100).toFixed(2)}% (decayed to g)`,
      origin: userSpec('revenue_cagr') ? 'user_assumption' : 'sourced',
      sourceRef: fromPrompt('revenue_cagr') ?? `Historical ${revenue.length}y · ${xbrlRef}`,
      citationN: userSpec('revenue_cagr') ? undefined : 1,
    },
    {
      field: 'ebit_margin',
      label: 'EBIT margin (flat across forecast)',
      value: `${(baseEbitMargin * 100).toFixed(2)}%`,
      origin: userSpec('ebit_margin') ? 'user_assumption' : 'sourced',
      sourceRef: fromPrompt('ebit_margin') ?? `Derived (EBIT ÷ revenue) · ${xbrlRef}`,
      citationN: userSpec('ebit_margin') ? undefined : 1,
    },
    {
      field: 'capex_pct_revenue',
      label: 'Capex / revenue',
      value: `${(baseCapexPctRevenue * 100).toFixed(2)}%`,
      origin: userSpec('capex_pct_revenue') ? 'user_assumption' : (capex.length > 0 ? 'sourced' : 'default'),
      sourceRef: fromPrompt('capex_pct_revenue')
        ?? (capex.length > 0 ? `Derived · ${xbrlRef}` : 'Default 4% (no capex tag in filings)'),
      citationN: userSpec('capex_pct_revenue') ? undefined : (capex.length > 0 ? 1 : undefined),
    },
    {
      field: 'da_pct_revenue',
      label: 'D&A / revenue',
      value: `${(baseDaPctRevenue * 100).toFixed(2)}%`,
      origin: ltm?.ltmDepreciationAmortization != null ? 'sourced' : 'default',
      sourceRef: ltm?.ltmDepreciationAmortization != null
        ? `XBRL DepreciationDepletionAndAmortization · LTM through ${ltm.periodEnd}`
        : 'Default 2.5% (no D&A tag in filings)',
      citationN: ltm?.ltmDepreciationAmortization != null ? 1 : undefined,
    },
    {
      field: 'nwc_pct_revenue',
      label: 'ΔNWC / Δrevenue',
      value: `${(nwcPctIncrementalRevenue * 100).toFixed(2)}%`,
      origin: userSpec('nwc_pct_revenue') ? 'user_assumption' : 'default',
      sourceRef: fromPrompt('nwc_pct_revenue') ?? 'Default 0% (working capital not modeled when not specified)',
    },
    { field: 'historical_cagr', label: 'Historical revenue CAGR (reference)', value: `${(historicalCagr * 100).toFixed(2)}%`, origin: 'sourced', sourceRef: `Derived from ${revenue.length}y revenue series · ${xbrlRef}`, citationN: 1 },
    { field: 'projection_years', label: 'Projection horizon', value: `${projectionYears}y`, origin: userSpec('projection_years') ? 'user_assumption' : 'default', sourceRef: userSpec('projection_years') ? 'Scope card' : 'Manifest default (5y)' },
    { field: 'wacc', label: 'WACC', value: `${waccPct.toFixed(2)}%`, origin: waccMethod === 'manual' && opts.scope.discount_rate != null ? 'user_assumption' : 'default', sourceRef: waccMethod === 'manual' && opts.scope.discount_rate != null ? 'Scope card (manual)' : `Default ${DEFAULT_COMPUTED_WACC_PCT}% (no CAPM input yet)` },
    { field: 'terminal_growth', label: 'Terminal growth (g)', value: `${terminalGrowthPct.toFixed(2)}%`, origin: userSpec('terminal_growth_rate') ? 'user_assumption' : 'default', sourceRef: userSpec('terminal_growth_rate') ? 'Scope card' : 'Manifest default (2.5%)' },
    { field: 'tax_rate', label: 'Effective tax rate', value: `${taxRatePct.toFixed(1)}%`, origin: userSpec('tax_rate') ? 'user_assumption' : 'default', sourceRef: userSpec('tax_rate') ? 'Scope card' : 'Manifest default (25%)' },
    { field: 'terminal_method', label: 'Terminal-value method', value: terminalMethod === 'gordon_growth' ? 'Gordon Growth' : 'Exit multiple', origin: userSpec('terminal_method') ? 'user_assumption' : 'default', sourceRef: userSpec('terminal_method') ? 'Scope card' : 'Manifest default (Gordon Growth)' },
  ];
  if (terminalMethod === 'exit_multiple' && exitMultiple != null) {
    inputs.push({ field: 'exit_multiple', label: 'Exit multiple', value: `${exitMultiple.toFixed(1)}x`, origin: userSpec('exit_multiple') ? 'user_assumption' : 'default', sourceRef: userSpec('exit_multiple') ? 'Scope card' : 'Manifest default (10x)' });
  }
  yield { type: 'inputs_traced', inputs };

  // Calc-step trail: show the math behind enterprise value so the Work tab
  // can render the derivation alongside the inputs.
  const lastProj = projections[projections.length - 1];
  const sumPv = projections.reduce((acc, p) => acc + p.pvFcf, 0);
  const calcSteps = [
    { step: 'EBIT margin (held flat)', expr: userSpec('ebit_margin') ? `from prompt` : `${fmtMillions(baseEbit)} ÷ ${fmtMillions(baseRevenue)}`, value: `${(baseEbitMargin * 100).toFixed(2)}%` },
    { step: 'Revenue CAGR',
      expr: projectedRevenueCagr != null ? `from prompt (flat)` : `(${fmtMillions(baseRevenue)} ÷ ${fmtMillions(oldestRevenue)})^(1/${yearsSpan}) − 1 (decayed)`,
      value: `${((projectedRevenueCagr ?? historicalCagr) * 100).toFixed(2)}%` },
    { step: `Year-${projectionYears} revenue`, expr: projectedRevenueCagr != null ? `${fmtMillions(baseRevenue)} × (1+${(projectedRevenueCagr*100).toFixed(2)}%)^${projectionYears}` : `Decay growth from ${(historicalCagr * 100).toFixed(1)}% toward g=${(g * 100).toFixed(1)}%`, value: fmtMillions(lastProj.revenue) },
    { step: `Year-${projectionYears} FCF`, expr: `EBIT×(1−t) + D&A − Capex − ΔNWC = ${fmtMillions(lastProj.taxedEbit)} + ${fmtMillions(lastProj.da)} − ${fmtMillions(lastProj.capex)} − ${fmtMillions(lastProj.deltaNwc)}`, value: fmtMillions(lastProj.fcf) },
    { step: 'PV of projection FCFs', expr: `Σ FCF_t ÷ (1+WACC)^t`, value: fmtMillions(sumPv) },
    terminalMethod === 'gordon_growth'
      ? { step: 'Terminal value (Gordon)', expr: `${fmtMillions(lastProj.fcf)} × (1+${(g * 100).toFixed(2)}%) ÷ (${(wacc * 100).toFixed(2)}% − ${(g * 100).toFixed(2)}%)`, value: fmtMillions(terminalValue) }
      : { step: 'Terminal value (Exit ×)', expr: `${fmtMillions(lastProj.ebit)} × ${(exitMultiple ?? 10).toFixed(1)}x`, value: fmtMillions(terminalValue) },
    { step: 'PV of terminal', expr: `${fmtMillions(terminalValue)} ÷ (1+${(wacc * 100).toFixed(2)}%)^${projectionYears}`, value: fmtMillions(pvTerminal) },
    { step: 'Enterprise value', expr: `Σ PV(FCF) + PV(TV)`, value: fmtMillions(enterpriseValue) },
  ];
  yield { type: 'calc_steps', calc: calcSteps };

  yield { type: 'token', text: renderDCFHtml(target, result, pre.entity?.ticker ?? null) };
  yield { type: 'done' };
}

/**
 * Coerce a scope value to a finite number. Handles numbers, numeric strings,
 * percent-formatted strings ("16%"), and stripped-percent ("16"). Returns
 * `fallback` for null / undefined / unparseable. Always logs to the console
 * when a value would have silently fallen through — surfaces extractor bugs.
 */
function toPct(v: unknown, fallback: number): number {
  if (v == null) return fallback;
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'string') {
    const cleaned = v.trim().replace(/%$/, '').trim();
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
    // eslint-disable-next-line no-console
    console.warn(`DCF scope value unparseable, falling back to ${fallback}: ${JSON.stringify(v)}`);
    return fallback;
  }
  return fallback;
}

function refusalCard(target: string, headline: string, body: string): string {
  return [
    `<div class="memo-rec-banner" style="border-left-color:#f87171">`,
    `  <div class="memo-rec-label" style="color:#f87171">DCF can't run</div>`,
    `  <div class="memo-rec-headline">${escape(target)} — ${escape(headline)}</div>`,
    `</div>`,
    `<p>${escape(body)}</p>`,
    `<p class="memo-disclaimer">Reply with corrected inputs to re-run.</p>`,
  ].join('\n');
}

function renderPreflightFailureHtml(pre: { reason: string; missingMetrics: string[]; detail: string; attempted: string[] }, target: string): string {
  return [
    `<div class="memo-rec-banner" style="border-left-color:#f87171">`,
    `  <div class="memo-rec-label" style="color:#f87171">DATA UNAVAILABLE</div>`,
    `  <div class="memo-rec-headline">${escape(target)} DCF — ${escape(pre.reason.replace(/_/g, ' '))}</div>`,
    `</div>`,
    `<p>${escape(pre.detail)}</p>`,
    pre.missingMetrics.length > 0
      ? `<p><strong>Missing:</strong> ${pre.missingMetrics.map(escape).join(', ')}</p>`
      : '',
    pre.attempted.length > 0
      ? `<p class="memo-disclaimer"><strong>Attempted sources:</strong> ${pre.attempted.map(escape).join(', ')}</p>`
      : '',
  ].filter(Boolean).join('\n');
}

function renderDCFHtml(target: string, r: DCFResultWithPeriod, ticker: string | null): string {
  const targetLabel = ticker ? `${target} (${ticker})` : target;

  // Headline EV banner
  const banner = `
    <div class="memo-rec-banner">
      <div class="memo-rec-label">ENTERPRISE VALUE</div>
      <div class="memo-rec-headline">${escape(targetLabel)} — ${fmtMillions(r.enterpriseValue)}</div>
      <div class="memo-rec-meta">
        ${fmtPctRaw(r.inputs.waccPct, 2)} WACC ·
        ${fmtPctRaw(r.inputs.terminalGrowthPct, 2)} terminal g ·
        ${r.inputs.projectionYears}y projection ·
        ${r.inputs.terminalMethod === 'gordon_growth' ? 'Gordon Growth' : `${r.inputs.exitMultiple ?? 10}x exit multiple`}
      </div>
    </div>
  `;

  const cagrLabel = r.inputs.projectedRevenueCagrPct != null
    ? `${fmtPctRaw(r.inputs.projectedRevenueCagrPct, 2)} (from prompt, flat)`
    : `${fmtPctRaw(r.inputs.historicalRevenueCagrPct, 2)} (historical, decayed to g)`;
  const assumptions = table({
    headers: ['Assumption', 'Value'],
    rows: [
      ['Base year', `${escape(r.baseYear.period)} · revenue ${fmtMillions(r.baseYear.revenue)} · EBIT ${fmtMillions(r.baseYear.ebit)}`],
      ['Revenue CAGR (forecast)', cagrLabel],
      ['EBIT margin (held flat)', fmtPctRaw(r.inputs.ebitMarginPct, 2)],
      ['Capex / revenue', fmtPctRaw(r.inputs.capexPctRevenue, 2)],
      ['D&A / revenue', fmtPctRaw(r.inputs.daPctRevenue, 2)],
      ['ΔNWC / Δrevenue', fmtPctRaw(r.inputs.nwcPctIncrementalRevenue, 2)],
      ['Tax rate', fmtPctRaw(r.inputs.taxRatePct, 0)],
      ['WACC', fmtPctRaw(r.inputs.waccPct, 2)],
      ['Terminal growth', fmtPctRaw(r.inputs.terminalGrowthPct, 2)],
      ['Terminal method', r.inputs.terminalMethod === 'gordon_growth' ? 'Gordon Growth' : `Exit Multiple (${r.inputs.exitMultiple ?? 10}x)`],
    ],
  });

  // Projection table — full unlevered-FCF bridge so the math is auditable.
  const projHeaders = ['Year', 'Revenue', 'EBIT', 'EBIT × (1 - t)', '+ D&A', '− Capex', '− ΔNWC', 'FCF', 'Disc factor', 'PV FCF'];
  const projRows = r.projections.map(p => [
    `Year ${p.year}`,
    { value: fmtMillions(p.revenue), numeric: true },
    { value: fmtMillions(p.ebit), numeric: true },
    { value: fmtMillions(p.taxedEbit), numeric: true },
    { value: fmtMillions(p.da), numeric: true },
    { value: fmtMillions(p.capex), numeric: true },
    { value: fmtMillions(p.deltaNwc), numeric: true },
    { value: fmtMillions(p.fcf), numeric: true, strong: true },
    { value: p.discountFactor.toFixed(3), numeric: true },
    { value: fmtMillions(p.pvFcf), numeric: true },
  ]);
  const projection = table({ compact: true, headers: projHeaders, rows: projRows, numericColumns: [1, 2, 3, 4, 5, 6, 7, 8, 9] });

  // EV summary
  const sumPvFcf = r.projections.reduce((s, p) => s + p.pvFcf, 0);
  const evSummary = table({
    headers: ['Component', 'Value'],
    rows: [
      ['Σ PV(FCF)', { value: fmtMillions(sumPvFcf), numeric: true }],
      ['Terminal value (undiscounted)', { value: fmtMillions(r.terminalValue), numeric: true }],
      ['PV(Terminal value)', { value: fmtMillions(r.pvTerminal), numeric: true }],
      [{ value: 'Enterprise value', strong: true }, { value: fmtMillions(r.enterpriseValue), numeric: true, strong: true }],
      ['EV / base-year revenue', { value: r.crosscheck.evRevenueX != null ? fmtMultiple(r.crosscheck.evRevenueX) : '—', numeric: true }],
      ['EV / base-year EBIT', { value: r.crosscheck.evEbitX != null ? fmtMultiple(r.crosscheck.evEbitX) : '—', numeric: true }],
    ],
    numericColumns: [1],
  });

  // Sensitivity grid
  const sensHeaders = ['WACC \\ g', ...r.sensitivity.growths.map(g => fmtPctRaw(g, 2))];
  const sensRows = r.sensitivity.waccs.map((w, i) => [
    fmtPctRaw(w, 2),
    ...r.sensitivity.matrix[i].map(v => ({
      value: Number.isFinite(v) ? fmtMillions(v) : '—',
      numeric: true,
      highlight: i === 2 && r.sensitivity.matrix[i].length === 5 ? false : undefined,
    })),
  ]);
  const sensitivity = table({
    compact: true,
    headers: sensHeaders,
    rows: sensRows,
    numericColumns: [1, 2, 3, 4, 5],
  });

  return [
    banner,
    `<h3 class="memo-h3">Assumptions</h3>`,
    assumptions,
    `<h3 class="memo-h3">Projection</h3>`,
    projection,
    `<h3 class="memo-h3">Enterprise value</h3>`,
    evSummary,
    `<h3 class="memo-h3">WACC × terminal growth sensitivity ($M EV)</h3>`,
    sensitivity,
    `<p class="memo-disclaimer">Reply with revised inputs (e.g. "use 11% WACC", "10y projection", "exit multiple 12x") to re-run.</p>`,
  ].join('\n');
}
