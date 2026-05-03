/**
 * Minimal-but-credible LBO calculator.
 *
 * Inputs are deal-level (entry EV, leverage, multiples) plus a base-year
 * financial profile (revenue, EBITDA margin). Outputs sources & uses,
 * year-by-year projection with debt schedule, exit math, and a sensitivity
 * grid. Numbers in $M unless otherwise noted.
 *
 * Assumptions are intentionally simple — flat margin, constant CAGR, single
 * debt tranche at fixed rate, principal sweeps after interest and capex.
 * Good enough for a sponsor base case at MD-pitch fidelity; not Goldman's
 * cash-flow waterfall.
 */

export interface LBOInputs {
  entryEV: number;             // $M
  initialRevenue: number;      // $M
  ebitdaMargin: number;        // decimal, e.g. 0.25
  revenueCAGR: number;         // decimal, e.g. 0.25
  leverageMultiple: number;    // x EBITDA
  costOfDebt: number;          // decimal, e.g. 0.09
  taxRate: number;             // decimal, default 0.25
  capexPctRevenue: number;     // decimal, default 0.05
  holdPeriod: number;          // years
  exitMultiple: number;        // x EBITDA
}

export interface AnnualRow {
  year: number;
  revenue: number;
  ebitda: number;
  ebitdaMargin: number;
  capex: number;
  taxes: number;
  freeCashFlow: number;
  interestExpense: number;
  principalPaid: number;
  debtBalance: number;
}

export interface SourcesUses {
  entryEV: number;
  debt: number;
  equity: number;
  debtPctOfEV: number;
}

export interface ExitSummary {
  exitYear: number;
  exitRevenue: number;
  exitEBITDA: number;
  exitMultiple: number;
  exitEV: number;
  exitDebt: number;
  equityProceeds: number;
}

export interface ReturnsSummary {
  initialEquity: number;
  exitEquity: number;
  irrPct: number;              // decimal
  moic: number;
  cashOnCash: number;
}

export interface SensitivityCell {
  exitMultiple: number;
  revenueCAGR: number;
  irrPct: number;
  moic: number;
}

export interface LBOResult {
  inputs: LBOInputs;
  sourcesUses: SourcesUses;
  schedule: AnnualRow[];
  exit: ExitSummary;
  returns: ReturnsSummary;
  sensitivity: SensitivityCell[][];      // rows = exitMultiple, cols = CAGR
  sensitivityAxes: {
    exitMultiples: number[];             // row labels
    cagrs: number[];                      // column labels (decimal)
  };
}

export function runLBO(inputs: LBOInputs): LBOResult {
  const sourcesUses = computeSourcesUses(inputs);
  const schedule = buildSchedule(inputs);
  const exit = computeExit(inputs, schedule);
  const returns = computeReturns(sourcesUses, exit, inputs.holdPeriod);
  const sensitivity = buildSensitivity(inputs, sourcesUses);
  return { inputs, sourcesUses, schedule, exit, returns, sensitivity: sensitivity.cells, sensitivityAxes: sensitivity.axes };
}

function computeSourcesUses(inputs: LBOInputs): SourcesUses {
  const initialEBITDA = inputs.initialRevenue * inputs.ebitdaMargin;
  const debt = clampPositive(inputs.leverageMultiple * initialEBITDA);
  const debtCapped = Math.min(debt, inputs.entryEV * 0.85);   // sanity cap
  const equity = inputs.entryEV - debtCapped;
  return {
    entryEV: inputs.entryEV,
    debt: debtCapped,
    equity,
    debtPctOfEV: debtCapped / inputs.entryEV,
  };
}

function buildSchedule(inputs: LBOInputs): AnnualRow[] {
  const rows: AnnualRow[] = [];
  let revenue = inputs.initialRevenue;
  let debtBalance = inputs.leverageMultiple * inputs.initialRevenue * inputs.ebitdaMargin;
  // year-0 row (entry)
  rows.push({
    year: 0,
    revenue,
    ebitda: revenue * inputs.ebitdaMargin,
    ebitdaMargin: inputs.ebitdaMargin,
    capex: 0,
    taxes: 0,
    freeCashFlow: 0,
    interestExpense: 0,
    principalPaid: 0,
    debtBalance,
  });

  for (let year = 1; year <= inputs.holdPeriod; year++) {
    revenue *= 1 + inputs.revenueCAGR;
    const ebitda = revenue * inputs.ebitdaMargin;
    const capex = revenue * inputs.capexPctRevenue;
    const interest = debtBalance * inputs.costOfDebt;
    const ebt = ebitda - capex - interest;
    const taxes = clampPositive(ebt) * inputs.taxRate;
    const fcf = ebitda - capex - interest - taxes;
    const principalPaid = clampPositive(Math.min(fcf, debtBalance));
    debtBalance = clampPositive(debtBalance - principalPaid);

    rows.push({
      year,
      revenue,
      ebitda,
      ebitdaMargin: inputs.ebitdaMargin,
      capex,
      taxes,
      freeCashFlow: fcf,
      interestExpense: interest,
      principalPaid,
      debtBalance,
    });
  }
  return rows;
}

function computeExit(inputs: LBOInputs, schedule: AnnualRow[]): ExitSummary {
  const last = schedule[schedule.length - 1];
  const exitEV = last.ebitda * inputs.exitMultiple;
  const equityProceeds = clampPositive(exitEV - last.debtBalance);
  return {
    exitYear: inputs.holdPeriod,
    exitRevenue: last.revenue,
    exitEBITDA: last.ebitda,
    exitMultiple: inputs.exitMultiple,
    exitEV,
    exitDebt: last.debtBalance,
    equityProceeds,
  };
}

function computeReturns(sourcesUses: SourcesUses, exit: ExitSummary, holdYears: number): ReturnsSummary {
  const initialEquity = sourcesUses.equity;
  const exitEquity = exit.equityProceeds;
  const moic = exitEquity / initialEquity;
  const irr = moic > 0 ? Math.pow(moic, 1 / holdYears) - 1 : -1;
  return {
    initialEquity,
    exitEquity,
    irrPct: irr,
    moic,
    cashOnCash: moic,
  };
}

function buildSensitivity(inputs: LBOInputs, _su: SourcesUses): {
  cells: SensitivityCell[][];
  axes: { exitMultiples: number[]; cagrs: number[] };
} {
  const xMid = inputs.exitMultiple;
  const exitMultiples = [xMid - 4, xMid - 2, xMid, xMid + 2, xMid + 4]
    .map(v => Math.max(2, Number(v.toFixed(1))));
  const cMid = inputs.revenueCAGR;
  const cagrs = [cMid - 0.10, cMid - 0.05, cMid, cMid + 0.05, cMid + 0.10]
    .map(v => Math.max(0, Number(v.toFixed(3))));

  const cells: SensitivityCell[][] = exitMultiples.map(m =>
    cagrs.map(c => {
      const stress = runLBOCore({ ...inputs, exitMultiple: m, revenueCAGR: c });
      return { exitMultiple: m, revenueCAGR: c, irrPct: stress.returns.irrPct, moic: stress.returns.moic };
    }),
  );
  return { cells, axes: { exitMultiples, cagrs } };
}

/** Internal: runs without sensitivity (avoids infinite recursion). */
function runLBOCore(inputs: LBOInputs): { returns: ReturnsSummary } {
  const sourcesUses = computeSourcesUses(inputs);
  const schedule = buildSchedule(inputs);
  const exit = computeExit(inputs, schedule);
  const returns = computeReturns(sourcesUses, exit, inputs.holdPeriod);
  return { returns };
}

function clampPositive(n: number): number {
  return Math.max(0, n);
}

/* --- Formatting helpers --- */

export function formatMillions(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}B`;
  return `$${Math.round(n).toLocaleString()}M`;
}

export function formatPct(n: number, places = 1): string {
  return `${(n * 100).toFixed(places)}%`;
}

export function formatMultiple(n: number): string {
  return `${n.toFixed(1)}x`;
}
