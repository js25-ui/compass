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

export interface DCFScope {
  projection_years?: string | number;
  wacc_method?: 'computed' | 'manual';
  discount_rate?: number;        // % — used when wacc_method = manual
  terminal_growth_rate?: number; // %
  terminal_method?: 'gordon_growth' | 'exit_multiple';
  exit_multiple?: number;        // x EBITDA — used when terminal_method = exit_multiple
  tax_rate?: number;             // %
  [k: string]: unknown;
}

interface ProjectionRow {
  year: number;
  revenue: number;
  ebit: number;
  taxedEbit: number;
  capex: number;
  fcf: number;
  discountFactor: number;
  pvFcf: number;
}

interface DCFResult {
  inputs: {
    waccPct: number;
    terminalGrowthPct: number;
    taxRatePct: number;
    capexPctRevenue: number;
    ebitMarginPct: number;
    historicalRevenueCagrPct: number;
    projectionYears: number;
    terminalMethod: 'gordon_growth' | 'exit_multiple';
    exitMultiple: number | null;
  };
  baseYear: { revenue: number; ebit: number; ebitda: number | null; period: string };
  projections: ProjectionRow[];
  terminalValue: number;
  pvTerminal: number;
  enterpriseValue: number;
  crosscheck: { evRevenueX: number | null; evEbitX: number | null };
  /** WACC × g sensitivity matrix of EV ($M). */
  sensitivity: { waccs: number[]; growths: number[]; matrix: number[][] };
}

const DEFAULT_COMPUTED_WACC_PCT = 9.0;     // placeholder until we plug CAPM
const PROJECTION_GROWTH_DECAY_FRAC = 0.5;  // pull yearly growth halfway from CAGR toward terminal each step

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

  // Base-year scalars (latest fiscal year).
  const baseRevenue = revenue[0].value!;
  const baseEbit = oi[0].value!;
  const baseEbitMargin = baseEbit / baseRevenue;
  const baseCapexPctRevenue = capex.length > 0 && capex[0].value != null
    ? capex[0].value / baseRevenue
    : 0.04;  // 4% of revenue is a reasonable cross-sector default

  // Historical CAGR — oldest annual to latest annual.
  const oldestRevenue = revenue[revenue.length - 1].value!;
  const yearsSpan = revenue.length - 1;
  const historicalCagr = yearsSpan > 0
    ? Math.pow(baseRevenue / oldestRevenue, 1 / yearsSpan) - 1
    : 0;

  // Resolve scope-driven parameters.
  const projectionYears = Number(opts.scope.projection_years ?? 5);
  const waccMethod = opts.scope.wacc_method ?? 'computed';
  const waccPct = waccMethod === 'manual' && opts.scope.discount_rate != null
    ? Number(opts.scope.discount_rate)
    : DEFAULT_COMPUTED_WACC_PCT;
  const wacc = waccPct / 100;
  const terminalGrowthPct = Number(opts.scope.terminal_growth_rate ?? 2.5);
  const g = terminalGrowthPct / 100;
  const taxRatePct = Number(opts.scope.tax_rate ?? 25);
  const taxRate = taxRatePct / 100;
  const terminalMethod = (opts.scope.terminal_method ?? 'gordon_growth') as 'gordon_growth' | 'exit_multiple';
  const exitMultiple = opts.scope.exit_multiple != null ? Number(opts.scope.exit_multiple) : null;

  if (terminalMethod === 'gordon_growth' && g >= wacc) {
    yield {
      type: 'token',
      text: refusalCard(target, 'Gordon Growth divergence',
        `Terminal growth ${(g * 100).toFixed(1)}% ≥ WACC ${(wacc * 100).toFixed(1)}%. Gordon Growth requires g < WACC. Lower terminal growth or raise WACC and re-run.`),
    };
    yield { type: 'done' };
    return;
  }

  yield {
    type: 'progress',
    step: `Projecting ${projectionYears}y · WACC ${waccPct.toFixed(2)}% · g ${terminalGrowthPct.toFixed(2)}% · tax ${taxRatePct.toFixed(0)}%`,
  };

  // Decaying growth rate from historical CAGR → terminal g across N years.
  const projections: ProjectionRow[] = [];
  let currentRevenue = baseRevenue;
  let currentGrowth = historicalCagr;
  for (let t = 1; t <= projectionYears; t++) {
    // Decay growth toward terminal each year. After projectionYears the growth
    // approximately equals g.
    currentGrowth = currentGrowth - (currentGrowth - g) * PROJECTION_GROWTH_DECAY_FRAC;
    currentRevenue = currentRevenue * (1 + currentGrowth);
    const ebit = currentRevenue * baseEbitMargin;
    const taxedEbit = ebit * (1 - taxRate);
    const capexProj = currentRevenue * baseCapexPctRevenue;
    const fcf = taxedEbit - capexProj;
    const discountFactor = Math.pow(1 + wacc, t);
    const pvFcf = fcf / discountFactor;
    projections.push({
      year: t,
      revenue: currentRevenue,
      ebit,
      taxedEbit,
      capex: capexProj,
      fcf,
      discountFactor,
      pvFcf,
    });
  }

  const lastFcf = projections[projections.length - 1].fcf;
  const lastEbitda = projections[projections.length - 1].ebit;  // we don't separate D&A — treat as EBIT-anchored multiple

  let terminalValue: number;
  if (terminalMethod === 'gordon_growth') {
    terminalValue = (lastFcf * (1 + g)) / (wacc - g);
  } else {
    const mult = exitMultiple ?? 10;
    terminalValue = lastEbitda * mult;
  }
  const pvTerminal = terminalValue / Math.pow(1 + wacc, projectionYears);

  const enterpriseValue = projections.reduce((sum, p) => sum + p.pvFcf, 0) + pvTerminal;

  const crosscheck = {
    evRevenueX: baseRevenue > 0 ? enterpriseValue / baseRevenue : null,
    evEbitX: baseEbit > 0 ? enterpriseValue / baseEbit : null,
  };

  // Sensitivity grid: WACC ±100bps × g ±100bps.
  const waccs = [waccPct - 1, waccPct - 0.5, waccPct, waccPct + 0.5, waccPct + 1].map(v => v / 100);
  const growths = [terminalGrowthPct - 1, terminalGrowthPct - 0.5, terminalGrowthPct, terminalGrowthPct + 0.5, terminalGrowthPct + 1].map(v => v / 100);
  const matrix = waccs.map(w => growths.map(gg => recomputeEV({
    projections, lastFcf, lastEbitda, projectionYears,
    wacc: w, g: gg, terminalMethod, exitMultiple,
  })));

  const result: DCFResult = {
    inputs: {
      waccPct,
      terminalGrowthPct,
      taxRatePct,
      capexPctRevenue: baseCapexPctRevenue * 100,
      ebitMarginPct: baseEbitMargin * 100,
      historicalRevenueCagrPct: historicalCagr * 100,
      projectionYears,
      terminalMethod,
      exitMultiple,
    },
    baseYear: {
      revenue: baseRevenue,
      ebit: baseEbit,
      ebitda: null,
      period: revenue[0].period,
    },
    projections,
    terminalValue,
    pvTerminal,
    enterpriseValue,
    crosscheck,
    sensitivity: { waccs: waccs.map(v => v * 100), growths: growths.map(v => v * 100), matrix },
  };

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
  const inputs: InputTrace[] = [
    { field: 'target', label: 'Target entity', value: `${pre.entity.name}${pre.entity.ticker ? ` (${pre.entity.ticker})` : ''}`, origin: 'sourced', sourceRef: pre.entity.cik ? `SEC EDGAR · CIK ${pre.entity.cik}` : 'Curated entity', citationN: 1 },
    { field: 'base_revenue', label: 'Base-year revenue', value: fmtMillions(baseRevenue), origin: 'sourced', sourceRef: xbrlRef, citationN: 1 },
    { field: 'base_ebit', label: 'Base-year EBIT', value: fmtMillions(baseEbit), origin: 'sourced', sourceRef: xbrlRef, citationN: 1 },
    { field: 'base_ebit_margin', label: 'Base EBIT margin', value: `${(baseEbitMargin * 100).toFixed(1)}%`, origin: 'sourced', sourceRef: `Derived (EBIT ÷ revenue) · ${xbrlRef}`, citationN: 1 },
    { field: 'base_capex_pct', label: 'Base capex % revenue', value: `${(baseCapexPctRevenue * 100).toFixed(2)}%`, origin: capex.length > 0 ? 'sourced' : 'default', sourceRef: capex.length > 0 ? `Derived · ${xbrlRef}` : 'Default 4% (no capex tag in filings)', citationN: capex.length > 0 ? 1 : undefined },
    { field: 'historical_cagr', label: 'Historical revenue CAGR', value: `${(historicalCagr * 100).toFixed(1)}%`, origin: 'sourced', sourceRef: `Derived from ${revenue.length}y revenue series · ${xbrlRef}`, citationN: 1 },
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
    { step: 'Base EBIT margin', expr: `${fmtMillions(baseEbit)} ÷ ${fmtMillions(baseRevenue)}`, value: `${(baseEbitMargin * 100).toFixed(2)}%` },
    { step: 'Historical revenue CAGR', expr: `(${fmtMillions(baseRevenue)} ÷ ${fmtMillions(oldestRevenue)})^(1/${yearsSpan}) − 1`, value: `${(historicalCagr * 100).toFixed(2)}%` },
    { step: `Year-${projectionYears} revenue`, expr: `Decay growth from ${(historicalCagr * 100).toFixed(1)}% toward g=${(g * 100).toFixed(1)}%`, value: fmtMillions(lastProj.revenue) },
    { step: `Year-${projectionYears} FCF`, expr: `EBIT × (1 − tax) − capex`, value: fmtMillions(lastProj.fcf) },
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

function recomputeEV(args: {
  projections: ProjectionRow[];
  lastFcf: number;
  lastEbitda: number;
  projectionYears: number;
  wacc: number;
  g: number;
  terminalMethod: 'gordon_growth' | 'exit_multiple';
  exitMultiple: number | null;
}): number {
  if (args.terminalMethod === 'gordon_growth' && args.g >= args.wacc) return NaN;
  const tv = args.terminalMethod === 'gordon_growth'
    ? (args.lastFcf * (1 + args.g)) / (args.wacc - args.g)
    : args.lastEbitda * (args.exitMultiple ?? 10);
  const pvTerminal = tv / Math.pow(1 + args.wacc, args.projectionYears);
  // Re-discount each FCF at the new WACC.
  const pvFcfs = args.projections.reduce((sum, p) => sum + p.fcf / Math.pow(1 + args.wacc, p.year), 0);
  return pvFcfs + pvTerminal;
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

function renderDCFHtml(target: string, r: DCFResult, ticker: string | null): string {
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

  const assumptions = table({
    headers: ['Assumption', 'Value'],
    rows: [
      ['Base year', `${escape(r.baseYear.period)} · revenue ${fmtMillions(r.baseYear.revenue)} · EBIT ${fmtMillions(r.baseYear.ebit)}`],
      ['EBIT margin (held flat)', fmtPctRaw(r.inputs.ebitMarginPct, 1)],
      ['Capex / revenue', fmtPctRaw(r.inputs.capexPctRevenue, 1)],
      ['Tax rate', fmtPctRaw(r.inputs.taxRatePct, 0)],
      ['Historical revenue CAGR', fmtPctRaw(r.inputs.historicalRevenueCagrPct, 1)],
      ['WACC', fmtPctRaw(r.inputs.waccPct, 2)],
      ['Terminal growth', fmtPctRaw(r.inputs.terminalGrowthPct, 2)],
      ['Terminal method', r.inputs.terminalMethod === 'gordon_growth' ? 'Gordon Growth' : `Exit Multiple (${r.inputs.exitMultiple ?? 10}x)`],
    ],
  });

  // Projection table
  const projHeaders = ['Year', 'Revenue', 'EBIT', 'EBIT × (1 - t)', 'Capex', 'FCF', 'Discount factor', 'PV FCF'];
  const projRows = r.projections.map(p => [
    `Year ${p.year}`,
    { value: fmtMillions(p.revenue), numeric: true },
    { value: fmtMillions(p.ebit), numeric: true },
    { value: fmtMillions(p.taxedEbit), numeric: true },
    { value: fmtMillions(p.capex), numeric: true },
    { value: fmtMillions(p.fcf), numeric: true, strong: true },
    { value: p.discountFactor.toFixed(3), numeric: true },
    { value: fmtMillions(p.pvFcf), numeric: true },
  ]);
  const projection = table({ compact: true, headers: projHeaders, rows: projRows, numericColumns: [1, 2, 3, 4, 5, 6, 7] });

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
