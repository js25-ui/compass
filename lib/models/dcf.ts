/**
 * Pure DCF calculator. Inputs in, outputs out, no IO, no streaming, no UI.
 *
 * Unlevered FCF bridge:
 *   FCF_t  = EBIT_t × (1 − tax) + D&A_t − Capex_t − ΔNWC_t
 *   EV     = Σ FCF_t / (1+WACC)^t  +  TV / (1+WACC)^N
 *   TV (Gordon) = FCF_N × (1+g) / (WACC − g)
 *   TV (Exit)   = EBIT_N × exit_multiple
 *
 * Lives in lib/models/ alongside lbo.ts so the Monte Carlo overlay can
 * call it programmatically and re-sample inputs. The DCF deliverable
 * pipeline (lib/agents/deliverables/dcf.ts) is a thin wrapper that
 * preflights + builds inputs + renders HTML around this function.
 */

export interface DCFInputs {
  baseRevenue: number;            // $M
  baseEbit: number;               // $M
  baseEbitMargin: number;         // decimal — applied to projected revenue each year
  baseCapexPctRevenue: number;    // decimal, e.g. 0.04
  baseDaPctRevenue: number;       // decimal, e.g. 0.025 (D&A / revenue)
  /** ΔNWC as a fraction of incremental revenue (not of total revenue).
   *  e.g. 0.01 means new NWC equal to 1% of each year's revenue increase. */
  nwcPctIncrementalRevenue: number;
  historicalCagr: number;         // decimal
  /** When set, projects revenue at this flat CAGR (overrides decayed-growth
   *  path off historical). Set by the pipeline when the user supplies
   *  revenue_cagr in scope. */
  projectedRevenueCagr?: number;
  projectionYears: number;        // integer
  waccPct: number;                // pct (9.0 = 9%)
  terminalGrowthPct: number;      // pct
  taxRatePct: number;             // pct
  terminalMethod: 'gordon_growth' | 'exit_multiple';
  exitMultiple: number | null;    // x EBIT, when terminalMethod = exit_multiple
  growthDecayFrac?: number;       // 0..1; defaults to 0.5 (halve growth-to-terminal each year)
}

export interface ProjectionRow {
  year: number;
  revenue: number;
  ebit: number;
  taxedEbit: number;
  da: number;
  capex: number;
  deltaNwc: number;
  fcf: number;
  discountFactor: number;
  pvFcf: number;
}

export interface DCFResult {
  inputs: {
    waccPct: number;
    terminalGrowthPct: number;
    taxRatePct: number;
    capexPctRevenue: number;
    daPctRevenue: number;
    nwcPctIncrementalRevenue: number;
    ebitMarginPct: number;
    historicalRevenueCagrPct: number;
    /** If the pipeline set projectedRevenueCagr, this is the flat forward
     *  CAGR used. Null when growth was decayed from historical. */
    projectedRevenueCagrPct: number | null;
    projectionYears: number;
    terminalMethod: 'gordon_growth' | 'exit_multiple';
    exitMultiple: number | null;
  };
  baseYear: { revenue: number; ebit: number; ebitda: number | null };
  projections: ProjectionRow[];
  terminalValue: number;
  pvTerminal: number;
  enterpriseValue: number;
  crosscheck: { evRevenueX: number | null; evEbitX: number | null };
  sensitivity: { waccs: number[]; growths: number[]; matrix: number[][] };
}

export class DCFComputeError extends Error {
  constructor(public field: string, message: string) {
    super(message);
    this.name = 'DCFComputeError';
  }
}

const DEFAULT_GROWTH_DECAY_FRAC = 0.5;

export function runDCF(inp: DCFInputs): DCFResult {
  for (const [key, val] of Object.entries(inp)) {
    if (key === 'terminalMethod' || key === 'exitMultiple') continue;
    if (val == null) continue;
    if (!Number.isFinite(val as number)) {
      throw new DCFComputeError(key, `DCF input ${key}=${String(val)} is not finite.`);
    }
  }
  const wacc = inp.waccPct / 100;
  const g = inp.terminalGrowthPct / 100;
  const taxRate = inp.taxRatePct / 100;
  if (inp.terminalMethod === 'gordon_growth' && g >= wacc) {
    throw new DCFComputeError('terminal_growth_rate', `Gordon Growth requires g < WACC (got g=${g}, WACC=${wacc}).`);
  }
  if (inp.projectionYears < 1) {
    throw new DCFComputeError('projection_years', `projection_years must be ≥1 (got ${inp.projectionYears}).`);
  }

  const decayFrac = inp.growthDecayFrac ?? DEFAULT_GROWTH_DECAY_FRAC;
  const useFlatCagr = inp.projectedRevenueCagr != null;
  const projections: ProjectionRow[] = [];
  let priorRevenue = inp.baseRevenue;
  let currentGrowth = useFlatCagr ? inp.projectedRevenueCagr! : inp.historicalCagr;
  for (let t = 1; t <= inp.projectionYears; t++) {
    if (!useFlatCagr) {
      // Decay historical growth toward terminal g each year.
      currentGrowth = currentGrowth - (currentGrowth - g) * decayFrac;
    }
    const currentRevenue = priorRevenue * (1 + currentGrowth);
    const ebit = currentRevenue * inp.baseEbitMargin;
    const taxedEbit = ebit * (1 - taxRate);
    const da = currentRevenue * inp.baseDaPctRevenue;
    const capexProj = currentRevenue * inp.baseCapexPctRevenue;
    // ΔNWC = nwcPctIncrementalRevenue × (revenue_t − revenue_{t-1}).
    // Negative incremental revenue (rare in projections) releases working
    // capital — keeps the sign consistent so we don't fabricate positive
    // FCF from declining sales.
    const deltaNwc = inp.nwcPctIncrementalRevenue * (currentRevenue - priorRevenue);
    const fcf = taxedEbit + da - capexProj - deltaNwc;
    const discountFactor = Math.pow(1 + wacc, t);
    const pvFcf = fcf / discountFactor;
    projections.push({
      year: t,
      revenue: currentRevenue,
      ebit,
      taxedEbit,
      da,
      capex: capexProj,
      deltaNwc,
      fcf,
      discountFactor,
      pvFcf,
    });
    priorRevenue = currentRevenue;
  }

  const last = projections[projections.length - 1];
  const lastFcf = last.fcf;
  const lastEbit = last.ebit;

  let terminalValue: number;
  if (inp.terminalMethod === 'gordon_growth') {
    terminalValue = (lastFcf * (1 + g)) / (wacc - g);
  } else {
    terminalValue = lastEbit * (inp.exitMultiple ?? 10);
  }
  const pvTerminal = terminalValue / Math.pow(1 + wacc, inp.projectionYears);

  const enterpriseValue = projections.reduce((sum, p) => sum + p.pvFcf, 0) + pvTerminal;

  const crosscheck = {
    evRevenueX: inp.baseRevenue > 0 ? enterpriseValue / inp.baseRevenue : null,
    evEbitX: inp.baseEbit > 0 ? enterpriseValue / inp.baseEbit : null,
  };

  // Sensitivity grid: WACC ±100bps × g ±100bps
  const waccs = [inp.waccPct - 1, inp.waccPct - 0.5, inp.waccPct, inp.waccPct + 0.5, inp.waccPct + 1].map(v => v / 100);
  const growths = [inp.terminalGrowthPct - 1, inp.terminalGrowthPct - 0.5, inp.terminalGrowthPct, inp.terminalGrowthPct + 0.5, inp.terminalGrowthPct + 1].map(v => v / 100);
  const matrix = waccs.map(w => growths.map(gg => recomputeEV({
    projections,
    lastFcf,
    lastEbit,
    projectionYears: inp.projectionYears,
    wacc: w,
    g: gg,
    terminalMethod: inp.terminalMethod,
    exitMultiple: inp.exitMultiple,
  })));

  return {
    inputs: {
      waccPct: inp.waccPct,
      terminalGrowthPct: inp.terminalGrowthPct,
      taxRatePct: inp.taxRatePct,
      capexPctRevenue: inp.baseCapexPctRevenue * 100,
      daPctRevenue: inp.baseDaPctRevenue * 100,
      nwcPctIncrementalRevenue: inp.nwcPctIncrementalRevenue * 100,
      ebitMarginPct: inp.baseEbitMargin * 100,
      historicalRevenueCagrPct: inp.historicalCagr * 100,
      projectedRevenueCagrPct: inp.projectedRevenueCagr != null ? inp.projectedRevenueCagr * 100 : null,
      projectionYears: inp.projectionYears,
      terminalMethod: inp.terminalMethod,
      exitMultiple: inp.exitMultiple,
    },
    baseYear: { revenue: inp.baseRevenue, ebit: inp.baseEbit, ebitda: null },
    projections,
    terminalValue,
    pvTerminal,
    enterpriseValue,
    crosscheck,
    sensitivity: { waccs: waccs.map(v => v * 100), growths: growths.map(v => v * 100), matrix },
  };
}

function recomputeEV(args: {
  projections: ProjectionRow[];
  lastFcf: number;
  lastEbit: number;
  projectionYears: number;
  wacc: number;
  g: number;
  terminalMethod: 'gordon_growth' | 'exit_multiple';
  exitMultiple: number | null;
}): number {
  if (args.terminalMethod === 'gordon_growth' && args.g >= args.wacc) return NaN;
  const tv = args.terminalMethod === 'gordon_growth'
    ? (args.lastFcf * (1 + args.g)) / (args.wacc - args.g)
    : args.lastEbit * (args.exitMultiple ?? 10);
  const pvTerminal = tv / Math.pow(1 + args.wacc, args.projectionYears);
  const pvFcfs = args.projections.reduce((sum, p) => sum + p.fcf / Math.pow(1 + args.wacc, p.year), 0);
  return pvFcfs + pvTerminal;
}
