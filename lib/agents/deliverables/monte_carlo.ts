/**
 * Monte Carlo overlay deliverable.
 *
 * Wraps lib/models/monte_carlo.ts. Reads the underlying model (LBO or DCF)
 * + base inputs from prior_context (the most-recent run in the chat),
 * parses the user's per-variable distribution strings, runs the simulation,
 * and renders a histogram + percentile table inline. Refuses cleanly if no
 * prior LBO/DCF run is in context.
 */

import {
  type DeliverableEvent,
  type InputTrace,
  escape,
  fmtMillions,
  fmtPctRaw,
  note,
  refusalCard,
  section,
  table,
} from './shared';
import { runLBO, type LBOInputs } from '@/lib/models/lbo';
import { runDCF, type DCFInputs } from '@/lib/models/dcf';
import {
  runMonteCarlo,
  type DistributionSpec,
  type MonteCarloResult,
} from '@/lib/models/monte_carlo';
import { fingerprintRun } from './citation_audit';

export interface MonteCarloScope {
  underlying_model?: 'lbo' | 'dcf';
  distributions?: string;
  trial_count?: number | string;
  random_seed?: number | string;
  hurdle?: number | string | null;
  /** When the user invokes Monte Carlo standalone (not as a follow-up to an
   *  LBO/DCF), they can paste a JSON base-inputs blob into the scope card.
   *  Optional — normal path is prior_context. */
  base_inputs?: string;
  [k: string]: unknown;
}

export async function* runMonteCarloPipeline(opts: {
  query: string;
  scope: MonteCarloScope;
  detectedTarget?: { name: string; ticker?: string } | null;
  priorContext?: {
    task_type: string;
    detected_target: { name: string; ticker?: string } | null;
    scope: Record<string, string | number | boolean | string[]>;
  } | null;
  /** The most-recent assistant turn's deliverable_context (set by chat
   *  route when threading prior_context). Provides the base inputs the
   *  overlay should sample around. */
  baseFromPrior?: { taskType: string; baseInputs: Record<string, number> } | null;
}): AsyncGenerator<DeliverableEvent, void> {
  const targetName = opts.detectedTarget?.name ?? opts.priorContext?.detected_target?.name ?? opts.query;
  const underlying = opts.scope.underlying_model ?? (opts.priorContext?.task_type as 'lbo' | 'dcf' | undefined) ?? 'lbo';

  yield { type: 'progress', step: `Preparing Monte Carlo overlay on ${underlying.toUpperCase()}…` };

  // 1) Resolve base inputs from prior_context.
  const priorScope = opts.priorContext?.scope ?? null;
  const priorTaskType = opts.priorContext?.task_type ?? null;
  if (!priorScope || (priorTaskType !== underlying && priorTaskType !== `${underlying}_analysis`)) {
    yield {
      type: 'token',
      text: refusalCard({
        deliverableLabel: 'MONTE CARLO',
        target: targetName,
        headline: 'no underlying model in context',
        detail: `Monte Carlo overlays an existing ${underlying.toUpperCase()} run — there is no completed ${underlying.toUpperCase()} in this conversation to sample around. Run a base ${underlying.toUpperCase()} first, then ask "Monte Carlo on that".`,
        options: [
          `Run an ${underlying.toUpperCase()} on this target, then re-request Monte Carlo as a follow-up.`,
          'The overlay needs the base scope (entry EV, leverage, margins, etc.) from a real prior run — refusing to fabricate it.',
        ],
      }),
    };
    yield { type: 'done' };
    return;
  }

  // 2) Build base inputs of the right shape from prior_context.scope.
  let baseInputs: Record<string, number>;
  let modelFn: (inp: Record<string, number>) => number | null;
  let outcomeLabel: string;
  let outcomeUnit: 'pct' | 'money';
  if (underlying === 'lbo') {
    const baseLBO = lboInputsFromScope(priorScope);
    if (baseLBO == null) {
      yield {
        type: 'token',
        text: refusalCard({
          deliverableLabel: 'MONTE CARLO',
          target: targetName,
          headline: 'incomplete LBO base inputs',
          detail: 'Prior LBO context is missing one or more required scope fields. Re-run the LBO and try again.',
        }),
      };
      yield { type: 'done' };
      return;
    }
    baseInputs = baseLBO as unknown as Record<string, number>;
    modelFn = (inp) => {
      try {
        const r = runLBO(inp as unknown as LBOInputs);
        return r.returns.irrPct;
      } catch { return null; }
    };
    outcomeLabel = 'IRR';
    outcomeUnit = 'pct';
  } else {
    const baseDCF = dcfInputsFromScope(priorScope);
    if (baseDCF == null) {
      yield {
        type: 'token',
        text: refusalCard({
          deliverableLabel: 'MONTE CARLO',
          target: targetName,
          headline: 'DCF base inputs missing',
          detail: 'DCF prior_context does not include base-year revenue / EBIT. Re-run the DCF on this target so the base scalars are in context, then try Monte Carlo again.',
        }),
      };
      yield { type: 'done' };
      return;
    }
    baseInputs = baseDCF as unknown as Record<string, number>;
    modelFn = (inp) => {
      try {
        const r = runDCF(inp as unknown as DCFInputs);
        return r.enterpriseValue;
      } catch { return null; }
    };
    outcomeLabel = 'Enterprise value';
    outcomeUnit = 'money';
  }

  // 3) Parse the user's distribution spec text.
  const distText = String(opts.scope.distributions ?? '').trim();
  const distParseResult = parseDistributions(distText, new Set(Object.keys(baseInputs)));
  if ('error' in distParseResult) {
    yield {
      type: 'token',
      text: refusalCard({
        deliverableLabel: 'MONTE CARLO',
        target: targetName,
        headline: 'distribution spec invalid',
        detail: distParseResult.error,
        options: [
          'Format each line as: "field: normal(mean, stdev)" or "uniform(min, max)" or "triangular(min, mode, max)".',
          `Available ${underlying.toUpperCase()} fields: ${Object.keys(baseInputs).join(', ')}.`,
        ],
      }),
    };
    yield { type: 'done' };
    return;
  }
  const distributions = distParseResult.distributions;

  const trialCount = clampInt(Number(opts.scope.trial_count ?? 10000), 100, 50000);
  const seed = clampInt(Number(opts.scope.random_seed ?? 42), 0, 2_000_000_000);
  const hurdleRaw = opts.scope.hurdle == null || opts.scope.hurdle === '' ? null : Number(opts.scope.hurdle);
  const hurdle = hurdleRaw != null && Number.isFinite(hurdleRaw) ? hurdleRaw : undefined;

  yield { type: 'progress', step: `Running ${trialCount.toLocaleString()} trials (seed ${seed})…` };

  let result: MonteCarloResult;
  try {
    result = runMonteCarlo({
      baseInputs,
      stochastic: distributions,
      modelFn,
      trials: trialCount,
      seed,
      hurdle,
    });
  } catch (err) {
    yield { type: 'error', error: err instanceof Error ? err.message : 'Monte Carlo failed' };
    yield { type: 'done' };
    return;
  }

  // 4) Sources — anchor to the prior model run's identity. The runId is a
  // deterministic fingerprint of the prior run's _model_* keys so the
  // citation audit can confirm this isn't a phantom pointer.
  const priorRunId = fingerprintRun(underlying, priorScope as Record<string, unknown>);
  const sources = [
    {
      n: 1,
      title: `${targetName} ${underlying.toUpperCase()} base run`,
      url: null,
      meta: `Base inputs sampled from the prior ${underlying.toUpperCase()} scope in this conversation (runId ${priorRunId})`,
      kind: 'prior_run' as const,
      runId: priorRunId,
    },
  ];
  yield { type: 'sources', sources };

  // 5) Input trace — base inputs (from prior_context) + sampled distributions.
  const inputs: InputTrace[] = [
    {
      field: 'underlying_model',
      label: 'Underlying model',
      value: underlying.toUpperCase(),
      origin: 'user_assumption',
      sourceRef: 'Scope card',
    },
    {
      field: 'trials',
      label: 'Trial count',
      value: result.trials.toLocaleString(),
      origin: 'user_assumption',
      sourceRef: 'Scope card',
    },
    {
      field: 'seed',
      label: 'Random seed',
      value: String(result.seed),
      origin: 'user_assumption',
      sourceRef: 'Scope card (reproducibility)',
    },
    ...Object.entries(baseInputs).map(([k, v]): InputTrace => ({
      field: `base_${k}`,
      label: `Base ${k}`,
      value: formatBaseInput(k, v, outcomeUnit),
      origin: 'sourced',
      sourceRef: `Prior ${underlying.toUpperCase()} run in this conversation`,
      citationN: 1,
    })),
    ...Object.entries(distributions).map(([k, spec]): InputTrace => ({
      field: `dist_${k}`,
      label: `${k} distribution`,
      value: describeDistribution(spec),
      origin: 'user_assumption',
      sourceRef: 'Scope card',
    })),
  ];
  if (hurdle != null) {
    inputs.push({
      field: 'hurdle',
      label: outcomeLabel + ' hurdle',
      value: outcomeUnit === 'pct' ? `${(hurdle * 100).toFixed(1)}%` : fmtMillions(hurdle),
      origin: 'user_assumption',
      sourceRef: 'Scope card',
    });
  }
  yield { type: 'inputs_traced', inputs };

  // 6) Calc steps — show the statistical summary.
  const fmtOut = (n: number) => outcomeUnit === 'pct' ? `${(n * 100).toFixed(2)}%` : fmtMillions(n);
  const calcSteps = [
    { step: 'Valid trials', expr: `${result.validTrials} of ${result.trials}`, value: `${result.failedTrials} failed` },
    { step: 'Mean outcome', expr: `(1/N) Σ x_i`, value: fmtOut(result.mean) },
    { step: 'Stdev', expr: `√((1/N) Σ (x_i − μ)²)`, value: outcomeUnit === 'pct' ? `${(result.stdev * 100).toFixed(2)} pp` : fmtMillions(result.stdev) },
    { step: 'P5 / P95', expr: 'sorted percentile interpolation', value: `${fmtOut(result.percentiles.p5)} / ${fmtOut(result.percentiles.p95)}` },
  ];
  if (result.probAboveHurdle != null) {
    calcSteps.push({
      step: `Prob. ${outcomeLabel} ≥ hurdle`,
      expr: `(# trials ≥ ${outcomeUnit === 'pct' ? `${(hurdle! * 100).toFixed(1)}%` : fmtMillions(hurdle!)}) ÷ N`,
      value: `${(result.probAboveHurdle * 100).toFixed(1)}%`,
    });
  }
  yield { type: 'calc_steps', calc: calcSteps };

  yield { type: 'progress', step: 'Rendering distribution chart…' };
  yield { type: 'token', text: renderMonteCarlo(targetName, underlying, outcomeLabel, outcomeUnit, distributions, result) };
  yield { type: 'done' };
}

/* ---------- Helpers ---------- */

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function describeDistribution(spec: DistributionSpec): string {
  switch (spec.kind) {
    case 'normal':     return `normal(μ=${spec.mean}, σ=${spec.stdev})`;
    case 'uniform':    return `uniform(${spec.min}, ${spec.max})`;
    case 'triangular': return `triangular(${spec.min}, mode=${spec.mode}, ${spec.max})`;
    case 'fixed':      return `fixed(${spec.value})`;
  }
}

function formatBaseInput(key: string, value: number, outcomeUnit: 'pct' | 'money'): string {
  // Heuristic formatters — IRR-like fields are pct decimals, EV/revenue fields
  // are $M, multiples are numbers. The Work tab shows the raw key alongside.
  if (key.endsWith('Pct') || key.endsWith('CAGR') || key === 'taxRate' || key === 'costOfDebt' || key === 'capexPctRevenue' || key === 'ebitdaMargin') {
    return `${(value * 100).toFixed(2)}%`;
  }
  if (key === 'leverageMultiple' || key === 'exitMultiple') return `${value.toFixed(2)}x`;
  if (key === 'holdPeriod' || key === 'projectionYears') return `${Math.round(value)}y`;
  if (outcomeUnit === 'money' || key.toLowerCase().includes('revenue') || key.toLowerCase().includes('ebit') || key === 'entryEV') {
    return fmtMillions(value);
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/* ---------- Distribution-spec parser ---------- */

interface ParseOk { distributions: Record<string, DistributionSpec> }
interface ParseErr { error: string }

function parseDistributions(text: string, allowedFields: Set<string>): ParseOk | ParseErr {
  const lines = text.split(/[\n;]+/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { error: 'No distribution specs provided.' };
  const distributions: Record<string, DistributionSpec> = {};
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.+)$/);
    if (!m) return { error: `Could not parse "${line}". Expected "field: dist(args)".` };
    const field = m[1];
    if (!allowedFields.has(field)) {
      return { error: `Field "${field}" is not a valid input for the underlying model. Allowed: ${Array.from(allowedFields).join(', ')}.` };
    }
    const spec = parseOneDist(m[2].trim());
    if ('error' in spec) return { error: `${field}: ${spec.error}` };
    distributions[field] = spec.spec;
  }
  return { distributions };
}

function parseOneDist(text: string): { spec: DistributionSpec } | { error: string } {
  // normal(a, b) | uniform(a, b) | triangular(a, b, c) | fixed(a)
  const m = text.match(/^(normal|uniform|triangular|fixed)\s*\(([^)]*)\)\s*$/i);
  if (!m) return { error: `Distribution must look like normal(a, b) / uniform(a, b) / triangular(a, b, c).` };
  const kind = m[1].toLowerCase();
  const parts = m[2].split(',').map(s => s.trim()).map(parseFloat);
  if (parts.some(p => !Number.isFinite(p))) {
    return { error: `Non-numeric argument(s) in "${text}".` };
  }
  if (kind === 'normal') {
    if (parts.length !== 2) return { error: 'normal expects exactly 2 args: mean, stdev.' };
    if (parts[1] <= 0) return { error: 'normal stdev must be positive.' };
    return { spec: { kind: 'normal', mean: parts[0], stdev: parts[1] } };
  }
  if (kind === 'uniform') {
    if (parts.length !== 2) return { error: 'uniform expects exactly 2 args: min, max.' };
    if (parts[1] <= parts[0]) return { error: 'uniform max must exceed min.' };
    return { spec: { kind: 'uniform', min: parts[0], max: parts[1] } };
  }
  if (kind === 'triangular') {
    if (parts.length !== 3) return { error: 'triangular expects 3 args: min, mode, max.' };
    const [lo, mode, hi] = parts;
    if (!(lo <= mode && mode <= hi) || hi <= lo) {
      return { error: `triangular requires min ≤ mode ≤ max and max > min (got ${lo}, ${mode}, ${hi}).` };
    }
    return { spec: { kind: 'triangular', min: lo, mode, max: hi } };
  }
  // fixed
  if (parts.length !== 1) return { error: 'fixed expects 1 arg.' };
  return { spec: { kind: 'fixed', value: parts[0] } };
}

/* ---------- Base-input adapters from prior_context.scope ---------- */

function lboInputsFromScope(scope: Record<string, unknown>): LBOInputs | null {
  // The chat route appends the underlying LBO's pure-function inputs as
  // `_model_*` keys when re-emitting deliverable_context at end of run.
  // Prefer those when present — they're the exact values the model used,
  // including XBRL-derived base scalars that aren't in the form scope.
  const entryEV = num(scope._model_entryEV) ?? num(scope.entry_ev);
  const initialRevenue = num(scope._model_initialRevenue);
  const leverageMultiple = num(scope._model_leverageMultiple) ?? num(scope.leverage_multiple) ?? 5;
  const revenueCAGR = num(scope._model_revenueCAGR) ?? normalize(num(scope.revenue_cagr) ?? 0.10);
  const ebitdaMargin = num(scope._model_ebitdaMargin) ?? normalize(num(scope.ebitda_margin) ?? 0.15);
  const exitMultiple = num(scope._model_exitMultiple) ?? num(scope.exit_multiple) ?? 10;
  const holdPeriod = num(scope._model_holdPeriod) ?? num(scope.hold_period) ?? 5;
  const costOfDebt = num(scope._model_costOfDebt) ?? normalize(num(scope.cost_of_debt) ?? 0.09);
  const capexPctRevenue = num(scope._model_capexPctRevenue) ?? normalize(num(scope.capex_pct_revenue) ?? 0.05);
  const taxRate = num(scope._model_taxRate) ?? 0.25;
  if (entryEV == null || initialRevenue == null) return null;
  return {
    entryEV,
    initialRevenue,
    ebitdaMargin,
    revenueCAGR,
    leverageMultiple,
    costOfDebt,
    taxRate,
    capexPctRevenue,
    holdPeriod,
    exitMultiple,
  };
}

function dcfInputsFromScope(scope: Record<string, unknown>): DCFInputs | null {
  // Prefer the prior DCF run's actual inputs (forwarded by the chat route
  // as `_model_*` keys). Fall back to plain scope fields only if the user
  // is invoking Monte Carlo standalone with hand-typed DCF base inputs.
  const baseRevenue = num(scope._model_baseRevenue) ?? num(scope.base_revenue);
  const baseEbit = num(scope._model_baseEbit) ?? num(scope.base_ebit);
  const baseEbitMargin = num(scope._model_baseEbitMargin)
    ?? num(scope.base_ebit_margin)
    ?? (baseRevenue && baseEbit ? baseEbit / baseRevenue : null);
  const baseCapexPctRevenue = num(scope._model_baseCapexPctRevenue) ?? num(scope.base_capex_pct_revenue) ?? 0.04;
  const historicalCagr = num(scope._model_historicalCagr) ?? num(scope.historical_cagr) ?? 0.05;
  if (baseRevenue == null || baseEbit == null || baseEbitMargin == null) return null;
  const projectionYears = num(scope._model_projectionYears) ?? num(scope.projection_years) ?? 5;
  const waccPct = num(scope._model_waccPct) ?? num(scope.discount_rate) ?? 9;
  const terminalGrowthPct = num(scope._model_terminalGrowthPct) ?? num(scope.terminal_growth_rate) ?? 2.5;
  const taxRatePct = num(scope._model_taxRatePct) ?? num(scope.tax_rate) ?? 25;
  const modelTerminalMethod = scope._model_terminalMethod;
  const terminalMethod = (
    modelTerminalMethod === 'exit_multiple' || scope.terminal_method === 'exit_multiple'
      ? 'exit_multiple' : 'gordon_growth'
  ) as 'gordon_growth' | 'exit_multiple';
  const exitMultiple = num(scope._model_exitMultiple) ?? num(scope.exit_multiple);
  return {
    baseRevenue,
    baseEbit,
    baseEbitMargin,
    baseCapexPctRevenue,
    historicalCagr,
    projectionYears: Math.round(projectionYears),
    waccPct,
    terminalGrowthPct,
    taxRatePct,
    terminalMethod,
    exitMultiple,
  };
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalize(v: number): number {
  return v <= 1 ? v : v / 100;
}

/* ---------- Rendering ---------- */

function renderMonteCarlo(
  targetName: string,
  underlying: string,
  outcomeLabel: string,
  outcomeUnit: 'pct' | 'money',
  distributions: Record<string, DistributionSpec>,
  r: MonteCarloResult,
): string {
  const fmt = (n: number) => outcomeUnit === 'pct' ? `${(n * 100).toFixed(2)}%` : fmtMillions(n);

  const headline = `<p><strong>${escape(targetName)} Monte Carlo · ${underlying.toUpperCase()} overlay · ${r.validTrials.toLocaleString()} valid trials · seed ${r.seed}</strong></p>`;

  // Histogram SVG
  const W = 760;
  const margin = { left: 60, right: 40, top: 30, bottom: 50 };
  const innerW = W - margin.left - margin.right;
  const innerH = 220;
  const H = innerH + margin.top + margin.bottom;
  const bins = r.histogram.binCounts.length;
  const binW = innerW / bins;
  const maxCount = Math.max(...r.histogram.binCounts);
  const bars = r.histogram.binCounts.map((c, i) => {
    const h = maxCount > 0 ? (c / maxCount) * innerH : 0;
    const x = margin.left + i * binW;
    const y = margin.top + (innerH - h);
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(binW - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="#4a90e2" fill-opacity="0.7" />`;
  }).join('');

  // P5/P50/P95 reference lines.
  const xForVal = (v: number): number => {
    const lo = r.histogram.binEdges[0];
    const hi = r.histogram.binEdges[r.histogram.binEdges.length - 1];
    if (hi === lo) return margin.left;
    return margin.left + ((v - lo) / (hi - lo)) * innerW;
  };
  const pctileLines = [
    { v: r.percentiles.p5, label: 'P5', color: '#fbbf24' },
    { v: r.percentiles.p50, label: 'P50', color: '#fff' },
    { v: r.percentiles.p95, label: 'P95', color: '#fbbf24' },
  ].map(({ v, label, color }) => {
    const x = xForVal(v).toFixed(1);
    return `
      <line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + innerH}" stroke="${color}" stroke-width="1" stroke-dasharray="3 3" />
      <text x="${x}" y="${margin.top - 6}" fill="${color}" font-size="10" text-anchor="middle">${label} ${fmt(v)}</text>`;
  }).join('\n');

  const hurdleLine = r.hurdle != null ? `
    <line x1="${xForVal(r.hurdle).toFixed(1)}" y1="${margin.top}" x2="${xForVal(r.hurdle).toFixed(1)}" y2="${margin.top + innerH}" stroke="#f87171" stroke-width="1.5" />
    <text x="${xForVal(r.hurdle).toFixed(1)}" y="${margin.top + innerH + 14}" fill="#f87171" font-size="10" text-anchor="middle">Hurdle ${fmt(r.hurdle)}</text>` : '';

  const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" style="background:#0d0d0d;border:1px solid #1f1f1f;display:block;margin:8px 0">
    <line x1="${margin.left}" y1="${margin.top + innerH}" x2="${margin.left + innerW}" y2="${margin.top + innerH}" stroke="#333" stroke-width="1" />
    ${bars}
    ${pctileLines}
    ${hurdleLine}
    <text x="${margin.left + innerW / 2}" y="${H - 8}" fill="#666" font-size="11" text-anchor="middle">${escape(outcomeLabel)} (n = ${r.validTrials.toLocaleString()})</text>
  </svg>`;

  // Percentile table
  const percentileRows = [
    ['P5', fmt(r.percentiles.p5)],
    ['P25', fmt(r.percentiles.p25)],
    ['P50 (median)', fmt(r.percentiles.p50)],
    ['P75', fmt(r.percentiles.p75)],
    ['P95', fmt(r.percentiles.p95)],
    ['Mean', fmt(r.mean)],
    ['Stdev', outcomeUnit === 'pct' ? `${(r.stdev * 100).toFixed(2)} pp` : fmtMillions(r.stdev)],
  ];
  const percentileTable = table({ compact: true, headers: ['Statistic', 'Value'], rows: percentileRows, numericColumns: [1] });

  const hurdleSummary = r.probAboveHurdle != null
    ? note(`<strong>Probability ${outcomeUnit === 'pct' ? `${outcomeLabel} ≥ ${(r.hurdle! * 100).toFixed(1)}%` : `${outcomeLabel} ≥ ${fmtMillions(r.hurdle!)}`}: ${(r.probAboveHurdle * 100).toFixed(1)}%</strong> (across ${r.validTrials.toLocaleString()} valid trials).`)
    : '';

  // Distribution summary
  const distRows = Object.entries(distributions).map(([k, spec]) => [k, describeDistribution(spec)]);
  const distTable = table({ compact: true, headers: ['Variable', 'Distribution'], rows: distRows });

  // Sample trials (first 3, full inputs + outcome)
  const sampleRows = r.sampleTrials.slice(0, 3).map((s, i) => [
    `#${i + 1}`,
    Object.entries(s.inputs).map(([k, v]) => `${k}=${(v as number).toFixed(3)}`).join(', '),
    s.outcome != null ? fmt(s.outcome) : 'failed',
  ]);
  const sampleTable = table({ compact: true, headers: ['Trial', 'Sampled inputs', outcomeLabel], rows: sampleRows });

  return [
    headline,
    svg,
    hurdleSummary,
    section('Outcome statistics'),
    percentileTable,
    section('Stochastic variables'),
    distTable,
    section('Sample trials'),
    sampleTable,
    note(`<strong>Reproducibility:</strong> seeded with ${r.seed} — re-running with the same seed and distributions yields identical results. ${r.failedTrials > 0 ? `${r.failedTrials} of ${r.trials.toLocaleString()} trials produced an infeasible model output and were dropped from the distribution.` : ''}`),
  ].join('\n');
}
