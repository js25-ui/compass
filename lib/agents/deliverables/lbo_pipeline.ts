import {
  formatMillions,
  formatMultiple,
  formatPct,
  runLBO,
  LBOComputeError,
  type LBOInputs,
  type LBOResult,
} from '@/lib/models/lbo';
import { LBO_MANIFEST } from '@/lib/models/manifests';
import { hasErrors, validateLBO, type ValidationIssue } from '@/lib/models/validators';
import { preflight, type PreflightFailure } from '@/lib/data/preflight';
import { pickAnnualHistory } from '@/lib/data/financial_facts';

export interface LBOScope {
  hold_period?: number;
  leverage_multiple?: number;
  revenue_cagr?: number;
  exit_multiple?: number;
  entry_ev?: number;
  ebitda_margin?: number;
  cost_of_debt?: number;
  capex_pct_revenue?: number;
  margin_trajectory?: 'flat' | 'expansion' | 'compression';
  exit_route?: string;
}

export interface LBOPipelineEvent {
  type:
    | 'progress'
    | 'preflight_failed'
    | 'validation_failed'
    | 'inputs_resolved'
    | 'model_complete'
    | 'token'
    | 'sources'
    | 'done'
    | 'error';
  step?: string;
  detail?: string;
  reason?: PreflightFailure['reason'];
  missingMetrics?: string[];
  attempted?: string[];
  issues?: ValidationIssue[];
  inputs?: LBOInputs;
  result?: LBOResult;
  text?: string;
  sources?: Array<{ n: number; title: string; url: string | null; meta: string }>;
  error?: string;
}

export async function* runLBOPipeline(opts: {
  query: string;
  scope: LBOScope;
  detectedTarget?: { name: string; ticker?: string } | null;
}): AsyncGenerator<LBOPipelineEvent, void> {
  // ---------- Layer 1: PRE-FLIGHT ----------
  yield { type: 'progress', step: 'Pre-flight: gathering required financials…' };
  const pre = await preflight({
    query: opts.query,
    detectedTarget: opts.detectedTarget,
    manifest: LBO_MANIFEST,
  });

  if (!pre.ok) {
    yield {
      type: 'preflight_failed',
      reason: pre.reason,
      missingMetrics: pre.missingMetrics,
      attempted: pre.attempted,
      detail: pre.detail,
    };
    yield {
      type: 'token',
      text: renderPreflightFailureHtml(pre, opts.detectedTarget?.name ?? opts.query),
    };
    yield { type: 'done' };
    return;
  }

  yield {
    type: 'progress',
    step: `Pulled ${formatMillions(pre.scalar.revenue)} revenue, ${formatMillions(pre.scalar.ebitda ?? 0)} EBITDA from ${pre.entity.name}…`,
  };

  // ---------- Build LBO inputs from real facts + user scope ----------
  const trailingRevenue = pre.scalar.revenue;
  const trailingEbitda = pre.scalar.ebitda ?? null;
  const trailingMargin = trailingEbitda != null && trailingRevenue > 0
    ? trailingEbitda / trailingRevenue
    : null;

  // Historical revenue CAGR (drives the high-growth detection below).
  const revHistory = pre.history.revenue ?? [];
  let historicalCagr: number | null = null;
  if (revHistory.length >= 2) {
    const latest = revHistory[0]?.value ?? null;
    const oldest = revHistory[revHistory.length - 1]?.value ?? null;
    if (latest != null && oldest != null && oldest > 0) {
      const yearsSpan = revHistory.length - 1;
      historicalCagr = Math.pow(latest / oldest, 1 / yearsSpan) - 1;
    }
  }

  // Forward-EBITDA underwriting: real PE buyers underwrite to forward EBITDA
  // only when current EBITDA isn't representative of the underwriting basis —
  // either the cost structure is still pre-scale (margin <5%) or the entry
  // multiple is at outright bubble territory (>40x). A healthy 25x trailing
  // multiple on a 7-15% margin business is just a normal premium LBO and
  // should be priced as-is.
  const FORWARD_TRIGGER_MULTIPLE_BUBBLE = 40;       // pure-multiple trigger
  const FORWARD_TRIGGER_MARGIN_BROKEN = 0.05;       // <5% trailing margin → EBITDA isn't representative
  const FORWARD_TRIGGER_MULTIPLE_BROKEN_MARGIN = 25; // when margin is broken, even 25x is too high
  const FORWARD_TRIGGER_CAGR = 0.15;
  const trailingMultiple = trailingEbitda != null && trailingEbitda > 0 && opts.scope.entry_ev != null
    ? opts.scope.entry_ev / trailingEbitda
    : null;

  let baseRevenue = trailingRevenue;
  let baseEbitdaMargin =
    opts.scope.ebitda_margin != null
      ? normalizePercent(opts.scope.ebitda_margin)
      : trailingMargin != null
        ? Math.max(0.05, Math.min(0.65, trailingMargin))
        : 0.20;
  let forwardBasis: {
    yearsForward: number;
    cagrUsed: number;
    marginUsed: number;
    forwardRevenue: number;
    forwardEbitda: number;
    forwardMultiple: number;
    trailingRevenue: number;
    trailingEbitda: number | null;
    trailingMultiple: number;
  } | null = null;

  const marginIsBroken = trailingMargin != null && trailingMargin < FORWARD_TRIGGER_MARGIN_BROKEN;
  const multipleAtBubble = trailingMultiple != null && trailingMultiple > FORWARD_TRIGGER_MULTIPLE_BUBBLE;
  const multipleHighWithBrokenMargin = marginIsBroken
    && trailingMultiple != null
    && trailingMultiple > FORWARD_TRIGGER_MULTIPLE_BROKEN_MARGIN;

  if (
    (multipleAtBubble || multipleHighWithBrokenMargin) &&
    historicalCagr != null &&
    historicalCagr > FORWARD_TRIGGER_CAGR &&
    opts.scope.entry_ev != null
  ) {
    const yearsForward = 2;
    const cagrUsed = opts.scope.revenue_cagr != null
      ? normalizePercent(opts.scope.revenue_cagr)
      : historicalCagr;
    // Margin floor: 'expansion' trajectory implies the buyer expects margin
    // recovery toward sector norms; otherwise assume modest improvement.
    const isExpansion = opts.scope.margin_trajectory === 'expansion';
    const marginFloor = isExpansion ? 0.15 : 0.10;
    const marginUsed = Math.max(trailingMargin ?? 0, marginFloor);

    const forwardRevenue = trailingRevenue * Math.pow(1 + cagrUsed, yearsForward);
    const forwardEbitda = forwardRevenue * marginUsed;
    const forwardMultiple = forwardEbitda > 0 ? opts.scope.entry_ev / forwardEbitda : Infinity;

    if (forwardMultiple <= 25 && forwardMultiple >= 5) {
      baseRevenue = forwardRevenue;
      baseEbitdaMargin = marginUsed;
      forwardBasis = {
        yearsForward,
        cagrUsed,
        marginUsed,
        forwardRevenue,
        forwardEbitda,
        forwardMultiple,
        trailingRevenue,
        trailingEbitda,
        trailingMultiple,
      };
      yield {
        type: 'progress',
        step: `High entry / trailing-EBITDA (${trailingMultiple.toFixed(0)}x) + ${(historicalCagr * 100).toFixed(0)}% historical CAGR → switching to forward-${yearsForward}y EBITDA basis (${forwardMultiple.toFixed(1)}x).`,
      };
    }
  }

  const initialRevenue = baseRevenue;
  const ebitdaMargin = baseEbitdaMargin;

  const ltdHistory = pre.history.long_term_debt ?? [];
  const _existingDebt = ltdHistory[0]?.value ?? 0;     // reserved for refinement; not yet wired into LBO calc

  // Entry EV is mandatory — the clarify card always asks for it, and we never
  // silently fall back to a derived number. If somehow scope.entry_ev is
  // missing or non-positive, validators below will block.
  const entryEV =
    opts.scope.entry_ev != null && opts.scope.entry_ev > 0
      ? opts.scope.entry_ev
      : 0;     // 0 → validators flag entry_ev as required

  const inputs: LBOInputs = {
    entryEV,
    initialRevenue,
    ebitdaMargin,
    revenueCAGR: normalizePercent(opts.scope.revenue_cagr ?? 0.20),
    leverageMultiple: opts.scope.leverage_multiple ?? 5.0,
    costOfDebt: normalizePercent(opts.scope.cost_of_debt ?? 0.09),
    taxRate: 0.25,
    capexPctRevenue: normalizePercent(opts.scope.capex_pct_revenue ?? 0.05),
    holdPeriod: Math.round(opts.scope.hold_period ?? 5),
    exitMultiple: opts.scope.exit_multiple ?? 11.0,
  };

  // ---------- Layer 2: INPUT VALIDATION ----------
  const issues = validateLBO(inputs);
  if (hasErrors(issues)) {
    yield { type: 'validation_failed', issues };
    yield {
      type: 'token',
      text: renderValidationFailureHtml(pre.entity.name, inputs, issues),
    };
    yield { type: 'done' };
    return;
  }

  yield { type: 'inputs_resolved', inputs };
  yield { type: 'progress', step: 'Running model — sources, debt schedule, returns, sensitivity…' };

  // ---------- Run the model with NaN guards ----------
  let result: LBOResult;
  try {
    result = runLBO(inputs);
  } catch (err) {
    const detail = err instanceof LBOComputeError
      ? `Field ${err.field}: ${err.message}`
      : err instanceof Error
        ? err.message
        : 'Unknown calculation error';
    yield { type: 'error', error: detail };
    yield { type: 'done' };
    return;
  }

  yield { type: 'model_complete', result };

  // ---------- Sources ----------
  const sources: Array<{ n: number; title: string; url: string | null; meta: string }> = [];
  const annualRevenue = pickAnnualHistory(toFactArray(pre.facts.revenue), 'revenue', 1)[0] ?? null;
  if (annualRevenue) {
    sources.push({
      n: 1,
      title: `${pre.entity.name} ${annualRevenue.period} financials`,
      url: pre.entity.cik
        ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${pre.entity.cik}&type=10-K`
        : null,
      meta: `SEC EDGAR · XBRL company facts · filed ${annualRevenue.filedAt?.slice(0, 10) ?? 'n/a'}`,
    });
  }
  if (sources.length) yield { type: 'sources', sources };

  yield { type: 'progress', step: 'Rendering deliverable…' };
  yield { type: 'token', text: renderLBOHtml(pre.entity.name, inputs, result, issues, forwardBasis) };
  yield { type: 'done' };
}

interface ForwardBasis {
  yearsForward: number;
  cagrUsed: number;
  marginUsed: number;
  forwardRevenue: number;
  forwardEbitda: number;
  forwardMultiple: number;
  trailingRevenue: number;
  trailingEbitda: number | null;
  trailingMultiple: number;
}

function toFactArray(v: unknown): import('@/lib/data/financial_facts').FinancialFact[] {
  if (Array.isArray(v)) return v as import('@/lib/data/financial_facts').FinancialFact[];
  if (v && typeof v === 'object') return [v as import('@/lib/data/financial_facts').FinancialFact];
  return [];
}

function normalizePercent(v: number): number {
  if (v <= 1) return v;
  return v / 100;
}

/** Used by the orchestrator (clarify) to populate entry_ev's default — not by the model. */
export function extractEntryEVFromQuery(q: string): number | null {
  const tMatch = q.match(/\$\s*([\d.]+)\s*T(?:r|rillion)?\b/i);
  if (tMatch) return Math.round(parseFloat(tMatch[1]) * 1_000_000);     // $T → $M
  const bMatch = q.match(/\$\s*([\d.]+)\s*B(?:n|illion)?\b/i);
  if (bMatch) return Math.round(parseFloat(bMatch[1]) * 1000);          // $B → $M
  const mMatch = q.match(/\$\s*([\d,.]+)\s*M(?:M|illion)?\b/i);
  if (mMatch) return Math.round(parseFloat(mMatch[1].replace(/,/g, '')));
  return null;
}

/* ---------- Renderers ---------- */

function renderPreflightFailureHtml(pre: PreflightFailure, displayName: string): string {
  const reasonLabel =
    pre.reason === 'unresolved' ? 'Entity not resolved'
      : pre.reason === 'no_filings' ? 'No SEC filings available'
        : 'Required financials not found';
  const missing = pre.missingMetrics.length > 0
    ? `<p><strong>Missing required data:</strong> ${pre.missingMetrics.map(m => `<code>${m}</code>`).join(', ')}.</p>`
    : '';
  const attempted = pre.attempted.length > 0
    ? `<p class="memo-disclaimer">Sources attempted: ${pre.attempted.join(' → ')}.</p>`
    : '';
  return [
    `<div class="memo-rec-banner" style="border-left-color:#fbbf24">
       <div class="memo-rec-label" style="color:#fbbf24">CANNOT RUN LBO MODEL</div>
       <div class="memo-rec-headline">${escape(displayName)}: ${escape(reasonLabel)}</div>
     </div>`,
    `<p>${escape(pre.detail)}</p>`,
    missing,
    `<p><strong>Options:</strong></p>
     <ul class="memo-bullets">
       <li>→ Try a public SEC filer with the same business model (e.g. an indexed peer).</li>
       <li>→ Provide revenue and EBITDA margin manually in the scope card and re-run.</li>
       <li>→ Use the chat to ask Compass what indexed entities are nearby — those have data.</li>
     </ul>`,
    attempted,
    `<p class="memo-disclaimer">Compass refuses to run financial models on default placeholder values. The model would produce numbers that look credible but aren't.</p>`,
  ].join('\n');
}

function renderValidationFailureHtml(targetName: string, inputs: LBOInputs, issues: ValidationIssue[]): string {
  const errors = issues.filter(i => i.level === 'error');
  return [
    `<div class="memo-rec-banner" style="border-left-color:#f87171">
       <div class="memo-rec-label" style="color:#f87171">INPUT VALIDATION FAILED</div>
       <div class="memo-rec-headline">${escape(targetName)} LBO can't run with the current scope.</div>
     </div>`,
    `<p>${errors.length} input${errors.length === 1 ? '' : 's'} need${errors.length === 1 ? 's' : ''} to be revised before the model will run:</p>`,
    `<ul class="memo-bullets">${errors
      .map(
        e => `<li>
          <strong>${escape(e.field ?? 'Input')}:</strong> ${escape(e.message)}
          ${e.suggestion ? `<div class="memo-risk-mitigation"><em>Suggested:</em> ${escape(e.suggestion)}</div>` : ''}
        </li>`,
      )
      .join('')}</ul>`,
    `<p class="memo-disclaimer">Reply with the revised inputs (e.g. "actually $11B EV" or "use $50M EBITDA"), or drop the EV from your prompt and let Compass infer it from base-year financials.</p>`,
  ].join('\n');
}

function renderLBOHtml(
  targetName: string,
  inputs: LBOInputs,
  result: LBOResult,
  issues: ValidationIssue[],
  forwardBasis: ForwardBasis | null,
): string {
  const su = result.sourcesUses;
  const ret = result.returns;
  const exit = result.exit;
  const ins = result.inputs;
  const warnings = issues.filter(i => i.level === 'warn');
  const warnBlock = warnings.length === 0
    ? ''
    : `<p class="memo-data-note" style="border-left-color:#fbbf24">
        <strong>Soft warnings (model still ran):</strong>
        <ul class="memo-bullets" style="margin-top:6px">
          ${warnings.map(w => `<li>${escape(w.message)}${w.suggestion ? ` — <em>${escape(w.suggestion)}</em>` : ''}</li>`).join('')}
        </ul>
      </p>`;

  const verdict = ret.irrPct >= 0.20
    ? `Returns clear a 20% IRR hurdle: <strong>${formatPct(ret.irrPct)} IRR / ${ret.moic.toFixed(2)}x MOIC</strong>.`
    : ret.irrPct >= 0.15
      ? `Returns clear a 15% hurdle but not 20%: <strong>${formatPct(ret.irrPct)} IRR / ${ret.moic.toFixed(2)}x MOIC</strong>.`
      : ret.irrPct >= 0
        ? `Returns fall below standard sponsor hurdle: <strong>${formatPct(ret.irrPct)} IRR / ${ret.moic.toFixed(2)}x MOIC</strong>.`
        : `Returns negative under these inputs: <strong>${formatPct(ret.irrPct)} IRR / ${ret.moic.toFixed(2)}x MOIC</strong>. The deal does not work as structured.`;

  const forwardBanner = forwardBasis === null
    ? ''
    : `<div class="memo-data-note" style="border-left-color:#60a5fa">
        <strong>Underwriting basis: forward EBITDA</strong> — entry EV implies <strong>${forwardBasis.trailingMultiple.toFixed(0)}x trailing EBITDA</strong> (${formatMillions(forwardBasis.trailingEbitda ?? 0)}), outside the standard LBO range. With a ${(forwardBasis.cagrUsed * 100).toFixed(0)}% revenue CAGR projected over ${forwardBasis.yearsForward}y at a ${(forwardBasis.marginUsed * 100).toFixed(0)}% EBITDA margin, forward EBITDA reaches ${formatMillions(forwardBasis.forwardEbitda)} → entry becomes <strong>${forwardBasis.forwardMultiple.toFixed(1)}x forward EBITDA</strong>. Model projects from this Year-${forwardBasis.yearsForward} forward base.
      </div>`;

  return [
    `<p><strong>${escape(targetName)} LBO · ${formatMillions(ins.entryEV)} entry EV · ${formatMultiple(ins.leverageMultiple)} leverage · ${ins.holdPeriod}Y hold</strong></p>`,
    forwardBanner,
    `<p>${verdict}</p>`,
    warnBlock,
    section('Sources & Uses'),
    `<table class="memo-table">
      <thead><tr><th>Item</th><th class="num">$M</th><th class="num">% of EV</th></tr></thead>
      <tbody>
        <tr><td>Entry Enterprise Value</td><td class="num">${formatMillions(su.entryEV)}</td><td class="num">100.0%</td></tr>
        <tr><td>New Debt (${formatMultiple(ins.leverageMultiple)} × LTM EBITDA)</td><td class="num">${formatMillions(su.debt)}</td><td class="num">${formatPct(su.debtPctOfEV)}</td></tr>
        <tr><td>Sponsor Equity</td><td class="num">${formatMillions(su.equity)}</td><td class="num">${formatPct(1 - su.debtPctOfEV)}</td></tr>
      </tbody>
    </table>`,
    section('Returns Summary'),
    `<table class="memo-table">
      <thead><tr><th>Metric</th><th class="num">Value</th></tr></thead>
      <tbody>
        <tr><td>Initial Sponsor Equity</td><td class="num">${formatMillions(ret.initialEquity)}</td></tr>
        <tr><td>Exit Equity Proceeds (Year ${exit.exitYear})</td><td class="num">${formatMillions(ret.exitEquity)}</td></tr>
        <tr><td>IRR</td><td class="num"><strong>${formatPct(ret.irrPct)}</strong></td></tr>
        <tr><td>MOIC</td><td class="num"><strong>${ret.moic.toFixed(2)}x</strong></td></tr>
      </tbody>
    </table>`,
    section('Annual Projection'),
    `<table class="memo-table memo-table-compact">
      <thead><tr><th>Yr</th><th class="num">Revenue</th><th class="num">EBITDA</th><th class="num">Capex</th><th class="num">FCF</th><th class="num">Interest</th><th class="num">Principal</th><th class="num">Debt Bal.</th></tr></thead>
      <tbody>
        ${result.schedule.map(row => `<tr>
          <td>${row.year}</td>
          <td class="num">${formatMillions(row.revenue)}</td>
          <td class="num">${formatMillions(row.ebitda)}</td>
          <td class="num">${row.year === 0 ? '—' : formatMillions(row.capex)}</td>
          <td class="num">${row.year === 0 ? '—' : formatMillions(row.freeCashFlow)}</td>
          <td class="num">${row.year === 0 ? '—' : formatMillions(row.interestExpense)}</td>
          <td class="num">${row.year === 0 ? '—' : formatMillions(row.principalPaid)}</td>
          <td class="num">${formatMillions(row.debtBalance)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`,
    section('Exit Math'),
    `<table class="memo-table">
      <thead><tr><th>Item</th><th class="num">Value</th></tr></thead>
      <tbody>
        <tr><td>Exit Year</td><td class="num">Y${exit.exitYear}</td></tr>
        <tr><td>Exit Revenue</td><td class="num">${formatMillions(exit.exitRevenue)}</td></tr>
        <tr><td>Exit EBITDA</td><td class="num">${formatMillions(exit.exitEBITDA)}</td></tr>
        <tr><td>Exit Multiple</td><td class="num">${formatMultiple(exit.exitMultiple)}</td></tr>
        <tr><td>Exit EV</td><td class="num">${formatMillions(exit.exitEV)}</td></tr>
        <tr><td>Less: Net Debt</td><td class="num">(${formatMillions(exit.exitDebt)})</td></tr>
        <tr><td><strong>Equity Proceeds</strong></td><td class="num"><strong>${formatMillions(exit.equityProceeds)}</strong></td></tr>
      </tbody>
    </table>`,
    section('Sensitivity — IRR (Exit Multiple × Revenue CAGR)'),
    `<table class="memo-table memo-table-compact">
      <thead><tr><th>Exit Mult →<br/>CAGR ↓</th>${result.sensitivityAxes.exitMultiples.map(m => `<th class="num">${formatMultiple(m)}</th>`).join('')}</tr></thead>
      <tbody>
        ${result.sensitivityAxes.cagrs.map((c, ci) => `<tr>
          <td><strong>${formatPct(c, 0)}</strong></td>
          ${result.sensitivityAxes.exitMultiples.map((_m, mi) => {
            const cell = result.sensitivity[mi][ci];
            const highlight = mi === Math.floor(result.sensitivityAxes.exitMultiples.length / 2) && ci === Math.floor(result.sensitivityAxes.cagrs.length / 2)
              ? ' class="num memo-cell-highlight"' : ' class="num"';
            return `<td${highlight}>${formatPct(cell.irrPct, 1)}</td>`;
          }).join('')}
        </tr>`).join('')}
      </tbody>
    </table>`,
    `<p class="memo-disclaimer">Single-tranche debt at ${formatPct(ins.costOfDebt)}. Flat ${formatPct(ins.ebitdaMargin)} EBITDA margin. ${formatPct(ins.capexPctRevenue)} capex / revenue. ${formatPct(0.25)} effective tax. Fixed exit-multiple assumption — no multiple compression / expansion modeled outside the sensitivity grid.</p>`,
  ].join('\n');
}

function section(heading: string): string {
  return `<h3 class="memo-h3">${escape(heading)}</h3>`;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
