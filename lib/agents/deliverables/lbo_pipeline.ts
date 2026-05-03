import { getAnnualFinancials } from '@/lib/retrieval/xbrl';
import { resolveEntity, type ResolvedEntity } from '@/lib/lookup/resolve';
import { haikuComplete } from '@/lib/llm/anthropic';
import {
  formatMillions,
  formatMultiple,
  formatPct,
  runLBO,
  type LBOInputs,
  type LBOResult,
} from '@/lib/models/lbo';

export interface LBOScope {
  hold_period?: number;
  leverage_multiple?: number;
  revenue_cagr?: number;       // percent (e.g. 35) or decimal (0.35) — we accept both
  exit_multiple?: number;
  // Less common but accepted:
  entry_ev?: number;           // $M
  ebitda_margin?: number;
  cost_of_debt?: number;
  capex_pct_revenue?: number;
}

export interface LBOPipelineEvent {
  type: 'progress' | 'inputs_resolved' | 'model_complete' | 'token' | 'sources' | 'done' | 'error';
  step?: string;
  inputs?: LBOInputs;
  result?: LBOResult;
  text?: string;
  sources?: Array<{ n: number; title: string; url: string | null; meta: string }>;
  error?: string;
}

interface FinancialProfile {
  initialRevenue: number;          // $M
  ebitdaMargin: number;            // decimal
  source: 'xbrl' | 'estimated' | 'default';
  sourceLabel: string;             // "Apple FY2024 10-K via XBRL" or "Sonnet estimate (private company)"
  filedAt?: string | null;
  url?: string | null;
}

/**
 * Run the full LBO deliverable pipeline. Gathers a base-case financial
 * profile for the target (XBRL when public; Haiku estimate when not),
 * normalizes the user-provided scope, runs the model, and renders an HTML
 * answer with sources & uses, returns, projection, and sensitivity.
 */
export async function* runLBOPipeline(opts: {
  query: string;
  scope: LBOScope;
  detectedTarget?: { name: string; ticker?: string } | null;
  entryEV?: number;            // override; defaults pulled from query when present
}): AsyncGenerator<LBOPipelineEvent, void> {
  yield { type: 'progress', step: 'Resolving target…' };

  const targetName = opts.detectedTarget?.name ?? extractTargetFromQuery(opts.query) ?? '';
  const resolved = targetName ? await resolveEntity(targetName) : null;
  const display = resolved?.name ?? targetName ?? 'the target';

  yield { type: 'progress', step: `Pulling financial profile for ${display}…` };
  const profile = await gatherFinancialProfile(resolved, display);

  // Normalize scope — accept percents as integers (35) or decimals (0.35).
  const inputs = buildInputs(opts.scope, opts.entryEV ?? extractEntryEVFromQuery(opts.query) ?? 5_000, profile);
  yield { type: 'inputs_resolved', inputs };

  yield { type: 'progress', step: 'Running model — sources, debt schedule, returns, sensitivity…' };
  const result = runLBO(inputs);
  yield { type: 'model_complete', result };

  const sources = profile.url
    ? [{
        n: 1,
        title: profile.sourceLabel,
        url: profile.url,
        meta: profile.source === 'xbrl' ? 'SEC EDGAR · XBRL company facts' : 'Compass model · derived',
      }]
    : [];
  if (sources.length) yield { type: 'sources', sources };

  yield { type: 'progress', step: 'Rendering deliverable…' };
  const html = renderLBOHtml(display, profile, result);
  yield { type: 'token', text: html };

  yield { type: 'done' };
}

function extractTargetFromQuery(q: string): string | null {
  // Cheap heuristic — try patterns like "of <X>" or "<X> at $..." or "<X> LBO"
  const ofMatch = q.match(/(?:of|on|for)\s+([A-Z][\w&.\-]+(?:\s+[A-Z][\w&.\-]+){0,3})/);
  if (ofMatch) return ofMatch[1];
  const lboMatch = q.match(/([A-Z][\w&.\-]+(?:\s+[A-Z][\w&.\-]+){0,3})\s+(?:LBO|take[- ]private|buyout)/i);
  if (lboMatch) return lboMatch[1];
  return null;
}

function extractEntryEVFromQuery(q: string): number | null {
  // "$50B" → 50000, "$1.3B" → 1300, "$520M" → 520
  const bMatch = q.match(/\$\s*([\d.]+)\s*B(?:n|illion)?\b/i);
  if (bMatch) return Math.round(parseFloat(bMatch[1]) * 1000);
  const mMatch = q.match(/\$\s*([\d,.]+)\s*M(?:M|illion)?\b/i);
  if (mMatch) return Math.round(parseFloat(mMatch[1].replace(/,/g, '')));
  return null;
}

async function gatherFinancialProfile(resolved: ResolvedEntity | null, displayName: string): Promise<FinancialProfile> {
  // 1. Try XBRL for public companies
  if (resolved?.cik) {
    try {
      const annuals = await getAnnualFinancials(resolved.cik);
      if (annuals.length > 0) {
        const latest = annuals[annuals.length - 1];
        const revenueM = (latest.revenue ?? 0) / 1_000_000;
        if (revenueM > 0) {
          // EBITDA margin: prefer operatingIncome/revenue if available, else 25%.
          let margin = 0.25;
          if (latest.operatingIncome != null && latest.revenue && latest.revenue > 0) {
            margin = clamp((latest.operatingIncome ?? 0) / latest.revenue, 0.05, 0.6);
          }
          return {
            initialRevenue: revenueM,
            ebitdaMargin: margin,
            source: 'xbrl',
            sourceLabel: `${resolved.name} FY${latest.fy} ${latest.source.form} via SEC XBRL`,
            filedAt: latest.source.filed,
            url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${resolved.cik}&type=10-K`,
          };
        }
      }
    } catch {
      // Fall through to estimate
    }
  }

  // 2. Sonnet/Haiku estimate when XBRL isn't available (private cos, sovereigns)
  const estimated = await estimateFinancials(displayName);
  if (estimated) return estimated;

  // 3. Last-resort default
  return {
    initialRevenue: 1000,
    ebitdaMargin: 0.20,
    source: 'default',
    sourceLabel: 'Compass default profile (no entity-specific data available)',
  };
}

interface EstimateOutput {
  revenue_m: number;
  ebitda_margin: number;
  rationale: string;
}

async function estimateFinancials(displayName: string): Promise<FinancialProfile | null> {
  const systemPrompt = `You estimate a base-year financial profile for an LBO model when no SEC filings are available.

Output STRICT JSON only:
{
  "revenue_m": <approximate latest-fiscal-year revenue in $M>,
  "ebitda_margin": <decimal, e.g. 0.25 for 25%>,
  "rationale": "<one sentence explaining the basis — public reports, comps, etc.>"
}

Rules:
- Use your training knowledge to ground these numbers. Be conservative.
- If you genuinely don't recognize the entity, return revenue_m=0.
- ebitda_margin between 0.05 and 0.55. Tech infrastructure typically 0.20-0.35; mature software 0.30-0.45; commodity/industrial 0.10-0.20.`;

  try {
    const raw = await haikuComplete({ systemPrompt, userMessage: displayName, maxTokens: 200 });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end < 0) return null;
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as EstimateOutput;
    if (!parsed.revenue_m || parsed.revenue_m <= 0) return null;
    return {
      initialRevenue: parsed.revenue_m,
      ebitdaMargin: clamp(parsed.ebitda_margin, 0.05, 0.55),
      source: 'estimated',
      sourceLabel: `Sonnet/Haiku estimate · ${parsed.rationale}`,
    };
  } catch {
    return null;
  }
}

function buildInputs(scope: LBOScope, entryEV: number, profile: FinancialProfile): LBOInputs {
  return {
    entryEV,
    initialRevenue: profile.initialRevenue,
    ebitdaMargin: profile.ebitdaMargin,
    revenueCAGR: normalizePercent(scope.revenue_cagr ?? 0.20),
    leverageMultiple: scope.leverage_multiple ?? 5.0,
    costOfDebt: normalizePercent(scope.cost_of_debt ?? 0.09),
    taxRate: 0.25,
    capexPctRevenue: normalizePercent(scope.capex_pct_revenue ?? 0.05),
    holdPeriod: Math.round(scope.hold_period ?? 5),
    exitMultiple: scope.exit_multiple ?? 11.0,
  };
}

/** Accept 25 or 0.25 → 0.25. Anything > 1 is treated as a percent. */
function normalizePercent(v: number): number {
  if (v <= 1) return v;
  return v / 100;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/* ---- HTML rendering ---- */

function renderLBOHtml(targetName: string, profile: FinancialProfile, r: LBOResult): string {
  const su = r.sourcesUses;
  const ret = r.returns;
  const exit = r.exit;
  const ins = r.inputs;
  const sourceTier = profile.source;

  const profileNote = sourceTier === 'xbrl'
    ? `<p class="memo-data-note">Base-year financials sourced from <strong>${escape(profile.sourceLabel)}</strong>${profile.filedAt ? ` (filed ${profile.filedAt.slice(0, 10)})` : ''}.</p>`
    : sourceTier === 'estimated'
      ? `<p class="memo-data-note"><strong>Note:</strong> No SEC filings available for ${escape(targetName)}. Base-year revenue and margin are <strong>model estimates</strong> — ${escape(profile.sourceLabel)}.</p>`
      : `<p class="memo-data-note"><strong>Note:</strong> No entity-specific financial data was available; a generic profile was used. Treat returns as illustrative only.</p>`;

  const headline = `<p><strong>${escape(targetName)} LBO · ${formatMillions(ins.entryEV)} entry EV · ${formatMultiple(ins.leverageMultiple)} leverage · ${ins.holdPeriod}Y hold</strong></p>`;

  const verdict = ret.irrPct >= 0.20
    ? `Returns clear a 20% IRR hurdle: <strong>${formatPct(ret.irrPct)} IRR / ${ret.moic.toFixed(1)}x MOIC</strong>.`
    : ret.irrPct >= 0.15
      ? `Returns clear a 15% hurdle but not 20%: <strong>${formatPct(ret.irrPct)} IRR / ${ret.moic.toFixed(1)}x MOIC</strong>.`
      : `Returns fall below standard sponsor hurdle: <strong>${formatPct(ret.irrPct)} IRR / ${ret.moic.toFixed(1)}x MOIC</strong>.`;

  return [
    headline,
    `<p>${verdict}</p>`,
    profileNote,

    `<h3 class="memo-h3">Sources &amp; Uses</h3>`,
    `<table class="memo-table">
      <thead><tr><th>Item</th><th class="num">$M</th><th class="num">% of EV</th></tr></thead>
      <tbody>
        <tr><td>Entry Enterprise Value</td><td class="num">${formatMillions(su.entryEV)}</td><td class="num">100.0%</td></tr>
        <tr><td>New Debt (${formatMultiple(ins.leverageMultiple)} × LTM EBITDA)</td><td class="num">${formatMillions(su.debt)}</td><td class="num">${formatPct(su.debtPctOfEV)}</td></tr>
        <tr><td>Sponsor Equity</td><td class="num">${formatMillions(su.equity)}</td><td class="num">${formatPct(1 - su.debtPctOfEV)}</td></tr>
      </tbody>
    </table>`,

    `<h3 class="memo-h3">Returns Summary</h3>`,
    `<table class="memo-table">
      <thead><tr><th>Metric</th><th class="num">Value</th></tr></thead>
      <tbody>
        <tr><td>Initial Sponsor Equity</td><td class="num">${formatMillions(ret.initialEquity)}</td></tr>
        <tr><td>Exit Equity Proceeds (Year ${exit.exitYear})</td><td class="num">${formatMillions(ret.exitEquity)}</td></tr>
        <tr><td>IRR</td><td class="num"><strong>${formatPct(ret.irrPct)}</strong></td></tr>
        <tr><td>MOIC</td><td class="num"><strong>${ret.moic.toFixed(2)}x</strong></td></tr>
      </tbody>
    </table>`,

    `<h3 class="memo-h3">Annual Projection</h3>`,
    `<table class="memo-table memo-table-compact">
      <thead><tr><th>Yr</th><th class="num">Revenue</th><th class="num">EBITDA</th><th class="num">Capex</th><th class="num">FCF</th><th class="num">Interest</th><th class="num">Principal</th><th class="num">Debt Bal.</th></tr></thead>
      <tbody>
        ${r.schedule.map(row => `<tr>
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

    `<h3 class="memo-h3">Exit Math</h3>`,
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

    `<h3 class="memo-h3">Sensitivity — IRR (Exit Multiple × Revenue CAGR)</h3>`,
    `<table class="memo-table memo-table-compact">
      <thead><tr><th>Exit Mult →<br/>CAGR ↓</th>${r.sensitivityAxes.exitMultiples.map(m => `<th class="num">${formatMultiple(m)}</th>`).join('')}</tr></thead>
      <tbody>
        ${r.sensitivityAxes.cagrs.map((c, ci) => `<tr>
          <td><strong>${formatPct(c, 0)}</strong></td>
          ${r.sensitivityAxes.exitMultiples.map((_m, mi) => {
            const cell = r.sensitivity[mi][ci];
            const highlight = mi === Math.floor(r.sensitivityAxes.exitMultiples.length / 2) && ci === Math.floor(r.sensitivityAxes.cagrs.length / 2)
              ? ' class="num memo-cell-highlight"' : ' class="num"';
            return `<td${highlight}>${formatPct(cell.irrPct, 1)}</td>`;
          }).join('')}
        </tr>`).join('')}
      </tbody>
    </table>`,

    `<p class="memo-disclaimer">Single-tranche debt at ${formatPct(ins.costOfDebt)}. Flat ${formatPct(ins.ebitdaMargin)} EBITDA margin. ${formatPct(ins.capexPctRevenue)} capex / revenue. ${formatPct(0.25)} effective tax. Fixed exit-multiple assumption — no multiple compression / expansion modeled outside the sensitivity grid.</p>`,
  ].join('\n');
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
