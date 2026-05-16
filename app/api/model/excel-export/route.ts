/**
 * Excel export endpoint — static-value workbook for a completed model run.
 *
 * Takes the prior_context payload from chat (task_type, detected_target,
 * scope with _model_* keys), re-runs the underlying pure model, and returns
 * a multi-tab .xlsx via SheetJS:
 *   - Inputs       (every input with citation reference)
 *   - Model        (year-by-year schedule for LBO / projection for DCF)
 *   - Outputs      (returns / EV summary)
 *   - Sensitivity  (the sensitivity grid)
 *   - Sources      (full citation list)
 *
 * No live formulas — values only. The "live-formula" version is a separate,
 * harder project.
 */

import { NextRequest } from 'next/server';
import * as XLSX from 'xlsx';
import { runLBO, type LBOInputs } from '@/lib/models/lbo';
import { runDCF, type DCFInputs } from '@/lib/models/dcf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ExportRequest {
  task_type?: string;
  detected_target?: { name: string; ticker?: string } | null;
  scope?: Record<string, unknown>;
}

export async function POST(request: NextRequest) {
  let body: ExportRequest;
  try {
    body = (await request.json()) as ExportRequest;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const taskType = body.task_type;
  const target = body.detected_target;
  const scope = body.scope ?? {};

  if (!taskType) {
    return new Response(JSON.stringify({ error: 'task_type is required (lbo or dcf)' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (taskType !== 'lbo' && taskType !== 'dcf') {
    return new Response(JSON.stringify({ error: `excel export not yet wired for task_type "${taskType}". Supported: lbo, dcf.` }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const wb = taskType === 'lbo'
      ? buildLBOWorkbook(target, scope)
      : buildDCFWorkbook(target, scope);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const targetSlug = (target?.name ?? 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const filename = `${targetSlug}-${taskType}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    return new Response(buf as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'export failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

/* ---------- LBO workbook ---------- */

function buildLBOWorkbook(
  target: { name: string; ticker?: string } | null | undefined,
  scope: Record<string, unknown>,
): XLSX.WorkBook {
  const inputs = lboInputsFrom(scope);
  if (!inputs) {
    throw new Error(`LBO export needs prior_context.scope with _model_entryEV and _model_initialRevenue. Re-run the LBO so those fields are populated, then retry the export.`);
  }
  const result = runLBO(inputs);

  const targetLabel = target?.name ? `${target.name}${target.ticker ? ` (${target.ticker})` : ''}` : '—';
  const wb = XLSX.utils.book_new();

  // --- Inputs tab ---
  const inputsRows: Array<[string, string | number, string, string]> = [
    ['Field', 'Value', 'Origin', 'Source'],
    ['Target', targetLabel, 'sourced', target?.ticker ? `SEC ticker ${target.ticker}` : 'Curated entity'],
    ['Entry EV ($M)', inputs.entryEV, 'user_assumption', 'Scope card'],
    ['Initial revenue ($M)', inputs.initialRevenue, 'sourced', 'SEC EDGAR · XBRL (latest annual)'],
    ['EBITDA margin', inputs.ebitdaMargin, originForKey(scope, 'ebitda_margin'), sourceForKey(scope, 'ebitda_margin', 'Derived from XBRL filings')],
    ['Revenue CAGR', inputs.revenueCAGR, originForKey(scope, 'revenue_cagr'), sourceForKey(scope, 'revenue_cagr', 'Manifest default (20%)')],
    ['Leverage multiple', inputs.leverageMultiple, originForKey(scope, 'leverage_multiple'), sourceForKey(scope, 'leverage_multiple', 'Manifest default (5.0x)')],
    ['Cost of debt', inputs.costOfDebt, originForKey(scope, 'cost_of_debt'), sourceForKey(scope, 'cost_of_debt', 'Manifest default (9%)')],
    ['Tax rate', inputs.taxRate, 'default', 'Compass default (25%)'],
    ['Capex % revenue', inputs.capexPctRevenue, originForKey(scope, 'capex_pct_revenue'), sourceForKey(scope, 'capex_pct_revenue', 'Manifest default (5%)')],
    ['Hold period (y)', inputs.holdPeriod, originForKey(scope, 'hold_period'), sourceForKey(scope, 'hold_period', 'Manifest default (5y)')],
    ['Exit multiple', inputs.exitMultiple, originForKey(scope, 'exit_multiple'), sourceForKey(scope, 'exit_multiple', 'Manifest default (11.0x)')],
  ];
  const inputsSheet = XLSX.utils.aoa_to_sheet(inputsRows);
  applyHeader(inputsSheet, 4);
  // Attach citation comments on every Value cell.
  for (let r = 1; r < inputsRows.length; r++) {
    const sourceText = String(inputsRows[r][3]);
    addCellComment(inputsSheet, r, 1, `Origin: ${inputsRows[r][2]}\nSource: ${sourceText}`);
  }
  inputsSheet['!cols'] = [{ wch: 26 }, { wch: 18 }, { wch: 18 }, { wch: 44 }];
  XLSX.utils.book_append_sheet(wb, inputsSheet, 'Inputs');

  // --- Model tab: year-by-year schedule ---
  const modelHeader = ['Year', 'Revenue ($M)', 'EBITDA ($M)', 'Margin', 'Capex ($M)', 'FCF ($M)', 'Interest ($M)', 'Principal ($M)', 'Debt balance ($M)'];
  const modelRows: Array<Array<string | number>> = [modelHeader];
  for (const row of result.schedule) {
    modelRows.push([
      row.year,
      round2(row.revenue),
      round2(row.ebitda),
      round4(row.ebitdaMargin),
      row.year === 0 ? '—' : round2(row.capex),
      row.year === 0 ? '—' : round2(row.freeCashFlow),
      row.year === 0 ? '—' : round2(row.interestExpense),
      row.year === 0 ? '—' : round2(row.principalPaid),
      round2(row.debtBalance),
    ]);
  }
  const modelSheet = XLSX.utils.aoa_to_sheet(modelRows);
  applyHeader(modelSheet, modelHeader.length);
  modelSheet['!cols'] = modelHeader.map(() => ({ wch: 14 }));
  XLSX.utils.book_append_sheet(wb, modelSheet, 'Model');

  // --- Outputs tab ---
  const su = result.sourcesUses;
  const ret = result.returns;
  const ex = result.exit;
  const outRows: Array<Array<string | number>> = [
    ['Metric', 'Value'],
    ['Entry EV ($M)', round2(su.entryEV)],
    ['Debt at close ($M)', round2(su.debt)],
    ['Sponsor equity ($M)', round2(su.equity)],
    ['Debt % of EV', round4(su.debtPctOfEV)],
    ['Exit year', ex.exitYear],
    ['Exit revenue ($M)', round2(ex.exitRevenue)],
    ['Exit EBITDA ($M)', round2(ex.exitEBITDA)],
    ['Exit multiple (x)', round2(ex.exitMultiple)],
    ['Exit EV ($M)', round2(ex.exitEV)],
    ['Net debt at exit ($M)', round2(ex.exitDebt)],
    ['Equity proceeds ($M)', round2(ex.equityProceeds)],
    ['MOIC', round2(ret.moic)],
    ['IRR', round4(ret.irrPct)],
  ];
  const outSheet = XLSX.utils.aoa_to_sheet(outRows);
  applyHeader(outSheet, 2);
  outSheet['!cols'] = [{ wch: 26 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, outSheet, 'Outputs');

  // --- Sensitivity tab: Exit multiple × Revenue CAGR → IRR ---
  const sensHeader: Array<string | number> = ['Exit ×  /  CAGR →', ...result.sensitivityAxes.cagrs.map(c => `${(c * 100).toFixed(1)}%`)];
  const sensRows: Array<Array<string | number>> = [sensHeader];
  result.sensitivityAxes.exitMultiples.forEach((mult, mi) => {
    sensRows.push([`${mult.toFixed(1)}x`, ...result.sensitivityAxes.cagrs.map((_c, ci) => round4(result.sensitivity[mi][ci].irrPct))]);
  });
  const sensSheet = XLSX.utils.aoa_to_sheet(sensRows);
  applyHeader(sensSheet, sensHeader.length);
  sensSheet['!cols'] = sensHeader.map(() => ({ wch: 12 }));
  XLSX.utils.book_append_sheet(wb, sensSheet, 'Sensitivity');

  // --- Sources tab ---
  const sourcesRows: Array<Array<string>> = [
    ['#', 'Title', 'URL', 'Meta'],
    ['1', `${targetLabel} latest annual financials`, sourceUrlForTicker(target?.ticker), 'SEC EDGAR · XBRL company facts · latest fiscal year'],
    ['2', 'LBO model definitions', '', 'Compass LBO calculator · lib/models/lbo.ts · pure deterministic function'],
  ];
  const sourcesSheet = XLSX.utils.aoa_to_sheet(sourcesRows);
  applyHeader(sourcesSheet, 4);
  sourcesSheet['!cols'] = [{ wch: 6 }, { wch: 36 }, { wch: 52 }, { wch: 56 }];
  XLSX.utils.book_append_sheet(wb, sourcesSheet, 'Sources');

  return wb;
}

/* ---------- DCF workbook ---------- */

function buildDCFWorkbook(
  target: { name: string; ticker?: string } | null | undefined,
  scope: Record<string, unknown>,
): XLSX.WorkBook {
  const inputs = dcfInputsFrom(scope);
  if (!inputs) {
    throw new Error(`DCF export needs prior_context.scope with _model_baseRevenue and _model_baseEbit. Re-run the DCF and try again.`);
  }
  const result = runDCF(inputs);
  const targetLabel = target?.name ? `${target.name}${target.ticker ? ` (${target.ticker})` : ''}` : '—';

  const wb = XLSX.utils.book_new();

  const inputsRows: Array<[string, string | number, string, string]> = [
    ['Field', 'Value', 'Origin', 'Source'],
    ['Target', targetLabel, 'sourced', target?.ticker ? `SEC ticker ${target.ticker}` : 'Curated entity'],
    ['Base revenue ($M)', inputs.baseRevenue, 'sourced', 'SEC EDGAR · XBRL latest annual revenue'],
    ['Base EBIT ($M)', inputs.baseEbit, 'sourced', 'SEC EDGAR · XBRL latest annual operating income'],
    ['Base EBIT margin', inputs.baseEbitMargin, 'sourced', 'Derived (EBIT ÷ revenue)'],
    ['Capex % revenue', inputs.baseCapexPctRevenue, 'sourced', 'Derived from XBRL or default 4%'],
    ['Historical CAGR', inputs.historicalCagr, 'sourced', 'Derived from multi-year revenue series'],
    ['Projection years', inputs.projectionYears, originForKey(scope, 'projection_years'), sourceForKey(scope, 'projection_years', 'Manifest default (5y)')],
    ['WACC (%)', inputs.waccPct, originForKey(scope, 'discount_rate'), sourceForKey(scope, 'discount_rate', 'Default 9% (CAPM not yet wired)')],
    ['Terminal growth (%)', inputs.terminalGrowthPct, originForKey(scope, 'terminal_growth_rate'), sourceForKey(scope, 'terminal_growth_rate', 'Manifest default (2.5%)')],
    ['Tax rate (%)', inputs.taxRatePct, originForKey(scope, 'tax_rate'), sourceForKey(scope, 'tax_rate', 'Manifest default (25%)')],
    ['Terminal method', inputs.terminalMethod, originForKey(scope, 'terminal_method'), sourceForKey(scope, 'terminal_method', 'Manifest default (Gordon Growth)')],
  ];
  if (inputs.exitMultiple != null) {
    inputsRows.push(['Exit multiple', inputs.exitMultiple, originForKey(scope, 'exit_multiple'), sourceForKey(scope, 'exit_multiple', 'Manifest default (10x)')]);
  }
  const inputsSheet = XLSX.utils.aoa_to_sheet(inputsRows);
  applyHeader(inputsSheet, 4);
  for (let r = 1; r < inputsRows.length; r++) {
    addCellComment(inputsSheet, r, 1, `Origin: ${inputsRows[r][2]}\nSource: ${inputsRows[r][3]}`);
  }
  inputsSheet['!cols'] = [{ wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 44 }];
  XLSX.utils.book_append_sheet(wb, inputsSheet, 'Inputs');

  // Projection rows
  const modelHeader = ['Year', 'Revenue ($M)', 'EBIT ($M)', 'Taxed EBIT ($M)', 'D&A ($M)', 'Capex ($M)', 'ΔNWC ($M)', 'FCF ($M)', 'Discount factor', 'PV(FCF) ($M)'];
  const modelRows: Array<Array<string | number>> = [modelHeader];
  for (const p of result.projections) {
    modelRows.push([
      p.year,
      round2(p.revenue),
      round2(p.ebit),
      round2(p.taxedEbit),
      round2(p.da),
      round2(p.capex),
      round2(p.deltaNwc),
      round2(p.fcf),
      round4(p.discountFactor),
      round2(p.pvFcf),
    ]);
  }
  const modelSheet = XLSX.utils.aoa_to_sheet(modelRows);
  applyHeader(modelSheet, modelHeader.length);
  modelSheet['!cols'] = modelHeader.map(() => ({ wch: 16 }));
  XLSX.utils.book_append_sheet(wb, modelSheet, 'Model');

  // Outputs
  const outRows: Array<Array<string | number>> = [
    ['Metric', 'Value'],
    ['Sum PV(FCF) ($M)', round2(result.projections.reduce((s, p) => s + p.pvFcf, 0))],
    ['Terminal value ($M)', round2(result.terminalValue)],
    ['PV of terminal ($M)', round2(result.pvTerminal)],
    ['Enterprise value ($M)', round2(result.enterpriseValue)],
    ['EV / Revenue', result.crosscheck.evRevenueX != null ? round2(result.crosscheck.evRevenueX) : '—'],
    ['EV / EBIT', result.crosscheck.evEbitX != null ? round2(result.crosscheck.evEbitX) : '—'],
  ];
  const outSheet = XLSX.utils.aoa_to_sheet(outRows);
  applyHeader(outSheet, 2);
  outSheet['!cols'] = [{ wch: 26 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, outSheet, 'Outputs');

  // Sensitivity: WACC × g → EV
  const sensHeader: Array<string | number> = ['WACC \\ g →', ...result.sensitivity.growths.map(g => `${g.toFixed(2)}%`)];
  const sensRows: Array<Array<string | number>> = [sensHeader];
  result.sensitivity.waccs.forEach((w, wi) => {
    sensRows.push([`${w.toFixed(2)}%`, ...result.sensitivity.growths.map((_g, gi) => round2(result.sensitivity.matrix[wi][gi]))]);
  });
  const sensSheet = XLSX.utils.aoa_to_sheet(sensRows);
  applyHeader(sensSheet, sensHeader.length);
  sensSheet['!cols'] = sensHeader.map(() => ({ wch: 12 }));
  XLSX.utils.book_append_sheet(wb, sensSheet, 'Sensitivity');

  // Sources
  const sourcesRows: Array<Array<string>> = [
    ['#', 'Title', 'URL', 'Meta'],
    ['1', `${targetLabel} latest annual financials`, sourceUrlForTicker(target?.ticker), 'SEC EDGAR · XBRL company facts · revenue + operating-income series'],
    ['2', 'DCF model definitions', '', 'Compass DCF calculator · lib/models/dcf.ts · pure deterministic function'],
  ];
  const sourcesSheet = XLSX.utils.aoa_to_sheet(sourcesRows);
  applyHeader(sourcesSheet, 4);
  sourcesSheet['!cols'] = [{ wch: 6 }, { wch: 36 }, { wch: 52 }, { wch: 56 }];
  XLSX.utils.book_append_sheet(wb, sourcesSheet, 'Sources');

  return wb;
}

/* ---------- Shared helpers ---------- */

function lboInputsFrom(scope: Record<string, unknown>): LBOInputs | null {
  const entryEV = num(scope._model_entryEV);
  const initialRevenue = num(scope._model_initialRevenue);
  if (entryEV == null || initialRevenue == null) return null;
  return {
    entryEV,
    initialRevenue,
    ebitdaMargin: num(scope._model_ebitdaMargin) ?? 0.15,
    revenueCAGR: num(scope._model_revenueCAGR) ?? 0.10,
    leverageMultiple: num(scope._model_leverageMultiple) ?? 5,
    costOfDebt: num(scope._model_costOfDebt) ?? 0.09,
    taxRate: num(scope._model_taxRate) ?? 0.25,
    capexPctRevenue: num(scope._model_capexPctRevenue) ?? 0.05,
    holdPeriod: num(scope._model_holdPeriod) ?? 5,
    exitMultiple: num(scope._model_exitMultiple) ?? 10,
  };
}

function dcfInputsFrom(scope: Record<string, unknown>): DCFInputs | null {
  const baseRevenue = num(scope._model_baseRevenue);
  const baseEbit = num(scope._model_baseEbit);
  const baseEbitMargin = num(scope._model_baseEbitMargin) ?? (baseRevenue && baseEbit ? baseEbit / baseRevenue : null);
  if (baseRevenue == null || baseEbit == null || baseEbitMargin == null) return null;
  return {
    baseRevenue,
    baseEbit,
    baseEbitMargin,
    baseCapexPctRevenue: num(scope._model_baseCapexPctRevenue) ?? 0.04,
    baseDaPctRevenue: num(scope._model_baseDaPctRevenue) ?? 0.025,
    nwcPctIncrementalRevenue: num(scope._model_nwcPctIncrementalRevenue) ?? 0,
    historicalCagr: num(scope._model_historicalCagr) ?? 0.05,
    projectedRevenueCagr: num(scope._model_projectedRevenueCagr) ?? undefined,
    projectionYears: Math.round(num(scope._model_projectionYears) ?? 5),
    waccPct: num(scope._model_waccPct) ?? 9,
    terminalGrowthPct: num(scope._model_terminalGrowthPct) ?? 2.5,
    taxRatePct: num(scope._model_taxRatePct) ?? 25,
    terminalMethod: (scope._model_terminalMethod === 'exit_multiple' ? 'exit_multiple' : 'gordon_growth'),
    exitMultiple: num(scope._model_exitMultiple),
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

function originForKey(scope: Record<string, unknown>, key: string): string {
  return scope[key] != null ? 'user_assumption' : 'default';
}

function sourceForKey(scope: Record<string, unknown>, key: string, defaultLabel: string): string {
  return scope[key] != null ? 'Scope card' : defaultLabel;
}

function sourceUrlForTicker(ticker: string | undefined): string {
  if (!ticker) return '';
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${ticker.toUpperCase()}&type=10-K`;
}

function applyHeader(sheet: XLSX.WorkSheet, columnCount: number): void {
  for (let c = 0; c < columnCount; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    const cell = sheet[addr];
    if (!cell) continue;
    cell.s = { font: { bold: true } };
  }
}

function addCellComment(sheet: XLSX.WorkSheet, r: number, c: number, text: string): void {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = sheet[addr];
  if (!cell) return;
  // SheetJS comment shape — array of {a, t}. We omit `a` (author) for cleanliness.
  cell.c = [{ a: 'Compass', t: text }];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
