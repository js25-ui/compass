/**
 * Pitch Book deliverable.
 *
 * Composite that runs Trading Comps, Precedent Transactions, optional LBO,
 * plus an executive summary + recommended action drafted by Sonnet. Renders
 * as a long-form HTML "deck-on-page" view in chat. PPTX export later.
 */

import { runLBO, type LBOInputs } from '@/lib/models/lbo';
import { lightPreflight } from '@/lib/data/preflight';
import {
  type DeliverableEvent,
  escape,
  fmtMillions,
  fmtPct,
  note,
  refusalCard,
  section,
  sonnetJson,
  table,
} from './shared';
import { runTradingCompsPipeline, type TradingCompsScope } from './trading_comps';
import { runPrecedentsPipeline, type PrecedentsScope } from './precedents';

export interface PitchBookScope {
  num_comps?: number;
  comp_universe_scope?: string;
  num_precedents?: number;
  precedent_window_months?: number;
  buyer_type?: string;
  include_lbo?: boolean;
  pitch_focus?: string;             // 'sell_side_ma' | 'follow_on' | 'strategic_overview' | 'buy_side_ma'
  [k: string]: unknown;
}

interface ExecAndRecOut {
  situation_overview: string;     // 3-5 sentences
  key_metrics: Array<{ label: string; value: string; note?: string }>;
  thesis_points: Array<{ headline: string; body: string }>;
  recommended_action: { headline: string; rationale: string; next_steps: string[] };
}

const EXEC_PROMPT = `You draft the executive-summary + recommendation framing for a sell-side / advisory pitch book.

Output STRICT JSON only:
{
  "situation_overview": "<3-5 sentence situation overview: who the target is, why now, what context drives the conversation>",
  "key_metrics": [
    { "label": "<short>", "value": "<value with units>", "note": "<optional 1-line>" }
  ],
  "thesis_points": [
    { "headline": "<5-9 word headline>", "body": "<1-2 sentences>" }
  ],
  "recommended_action": {
    "headline": "<short action headline, e.g. 'Run a single-track sell-side process targeting strategic + sponsor universe Q3'>",
    "rationale": "<2-3 sentences>",
    "next_steps": ["<step 1>", "<step 2>", "<step 3>"]
  }
}

Voice: terse, professional, banker. No emoji. No "we think". 4-6 thesis points; 4-7 key metrics.`;

async function genExecAndRec(target: string, focus: string, query: string): Promise<ExecAndRecOut> {
  const userMessage = `Target: ${target}
Pitch focus: ${focus}
Original ask: ${query}

Draft executive summary, key metrics, thesis points, and recommended action grounded in your training-data knowledge of this company. Tag any data that's an estimate.`;
  return sonnetJson<ExecAndRecOut>({ systemPrompt: EXEC_PROMPT, userMessage, maxTokens: 2000 });
}

async function collectFromGenerator(
  generator: AsyncGenerator<DeliverableEvent, void>,
): Promise<{ html: string; error?: string }> {
  let html = '';
  let error: string | undefined;
  for await (const ev of generator) {
    if (ev.type === 'token') html += ev.text ?? '';
    if (ev.type === 'error') error = ev.error;
  }
  return { html, error };
}

export async function* runPitchBookPipeline(opts: {
  query: string;
  scope: PitchBookScope;
  detectedTarget?: { name: string; ticker?: string } | null;
}): AsyncGenerator<DeliverableEvent, void> {
  const target = opts.detectedTarget?.name ?? opts.query;
  const focus = opts.scope.pitch_focus ?? 'strategic_overview';
  const includeLBO = opts.scope.include_lbo ?? true;

  yield { type: 'progress', step: `Pre-flight: resolving ${target}…` };
  const pre = await lightPreflight({ query: opts.query, detectedTarget: opts.detectedTarget });
  if (!pre.ok) {
    yield {
      type: 'token',
      text: refusalCard({
        deliverableLabel: 'PITCH BOOK',
        target,
        headline: 'target not found',
        detail: pre.detail,
        options: [
          'Provide a known company name or ticker.',
          'For a sector pitch without a specific target, ask "what\'s new in [sector]" via chat.',
        ],
      }),
    };
    yield { type: 'done' };
    return;
  }

  const resolvedName = pre.entity.name;

  yield { type: 'progress', step: `Assembling pitch book for ${resolvedName} (${focus.replace(/_/g, ' ')})…` };

  yield { type: 'progress', step: 'Section 1/5 · Executive summary + thesis…' };
  let exec: ExecAndRecOut | null = null;
  try {
    exec = await genExecAndRec(resolvedName, focus, opts.query);
  } catch (err) {
    yield { type: 'error', error: `Exec summary generation failed: ${err instanceof Error ? err.message : 'unknown'}` };
    yield { type: 'done' };
    return;
  }

  yield { type: 'progress', step: 'Section 2/5 · Trading comps…' };
  const compsResult = await collectFromGenerator(
    runTradingCompsPipeline({
      query: opts.query,
      scope: {
        num_comps: opts.scope.num_comps ?? 8,
        comp_universe_scope: opts.scope.comp_universe_scope ?? 'sector_plus',
      } as TradingCompsScope,
      detectedTarget: opts.detectedTarget,
    }),
  );

  yield { type: 'progress', step: 'Section 3/5 · Precedent transactions…' };
  const precResult = await collectFromGenerator(
    runPrecedentsPipeline({
      query: opts.query,
      scope: {
        num_precedents: opts.scope.num_precedents ?? 6,
        precedent_window_months: opts.scope.precedent_window_months ?? 60,
        buyer_type: opts.scope.buyer_type ?? 'both',
      } as PrecedentsScope,
      detectedTarget: opts.detectedTarget,
    }),
  );

  let lboHtml = '';
  if (includeLBO) {
    yield { type: 'progress', step: 'Section 4/5 · LBO scenario (sponsor lens)…' };
    lboHtml = renderLBOScenario(resolvedName, exec.key_metrics);
  }

  yield { type: 'progress', step: 'Section 5/5 · Recommended action…' };

  yield { type: 'progress', step: 'Rendering deck…' };
  yield {
    type: 'token',
    text: renderPitchBookHtml({
      target: resolvedName,
      focus,
      exec,
      compsHtml: compsResult.html || '<p><em>Trading comps section failed to generate.</em></p>',
      precedentsHtml: precResult.html || '<p><em>Precedents section failed to generate.</em></p>',
      lboHtml,
    }),
  };
  yield { type: 'done' };
}

interface PitchKeyMetric {
  label: string;
  value: string;
}

function renderLBOScenario(target: string, keyMetrics: PitchKeyMetric[]): string {
  // Best-effort: parse a revenue + margin from the key_metrics if available;
  // fall back to defaults that produce an illustrative LBO.
  const revenueGuess = guessNumberFromMetrics(keyMetrics, /revenue/i) ?? 1000;
  const marginGuess = guessPctFromMetrics(keyMetrics, /(ebitda|operating).*margin/i) ?? 0.20;

  const inputs: LBOInputs = {
    entryEV: revenueGuess * (marginGuess > 0 ? marginGuess * 11 : 11),  // 11x EBITDA assumed entry
    initialRevenue: revenueGuess,
    ebitdaMargin: marginGuess,
    revenueCAGR: 0.15,
    leverageMultiple: 6.0,
    costOfDebt: 0.09,
    taxRate: 0.25,
    capexPctRevenue: 0.05,
    holdPeriod: 5,
    exitMultiple: 11.0,
  };
  const result = runLBO(inputs);

  return [
    `<p><strong>Illustrative sponsor LBO — ${escape(target)}</strong></p>`,
    `<p>Sponsor base case: 6.0x leverage, 5Y hold, 11x entry / 11x exit, 15% revenue CAGR. Returns: <strong>${fmtPct(result.returns.irrPct)} IRR / ${result.returns.moic.toFixed(2)}x MOIC</strong>. Entry equity ${fmtMillions(result.sourcesUses.equity)}, exit equity ${fmtMillions(result.returns.exitEquity)}.</p>`,
    table({
      headers: ['Metric', 'Value'],
      rows: [
        ['Entry EV (assumed 11x base EBITDA)', fmtMillions(result.sourcesUses.entryEV)],
        ['New Debt (6.0x)', fmtMillions(result.sourcesUses.debt)],
        ['Sponsor Equity', fmtMillions(result.sourcesUses.equity)],
        [{ value: 'Exit EV (Y5 EBITDA × 11x)', strong: true }, { value: fmtMillions(result.exit.exitEV), strong: true, numeric: true }],
        [{ value: 'Equity Proceeds', strong: true }, { value: fmtMillions(result.exit.equityProceeds), strong: true, numeric: true }],
        [{ value: 'IRR', strong: true }, { value: fmtPct(result.returns.irrPct), strong: true, numeric: true }],
        [{ value: 'MOIC', strong: true }, { value: `${result.returns.moic.toFixed(2)}x`, strong: true, numeric: true }],
      ],
      numericColumns: [1],
    }),
    `<p class="memo-disclaimer">Illustrative sponsor base case using inferred revenue / margin from the situation overview. Drive a precise LBO via the dedicated "Build LBO model" task to override entry EV, leverage, and exit multiple.</p>`,
  ].join('');
}

function guessNumberFromMetrics(metrics: PitchKeyMetric[], pattern: RegExp): number | null {
  for (const m of metrics) {
    if (!pattern.test(m.label)) continue;
    const cleaned = m.value.replace(/[$,]/g, '').toLowerCase();
    const bn = cleaned.match(/([\d.]+)\s*b/);
    if (bn) return parseFloat(bn[1]) * 1000;
    const mn = cleaned.match(/([\d.]+)\s*m/);
    if (mn) return parseFloat(mn[1]);
  }
  return null;
}

function guessPctFromMetrics(metrics: PitchKeyMetric[], pattern: RegExp): number | null {
  for (const m of metrics) {
    if (!pattern.test(m.label)) continue;
    const pct = m.value.match(/([\d.]+)\s*%/);
    if (pct) return parseFloat(pct[1]) / 100;
  }
  return null;
}

interface RenderArgs {
  target: string;
  focus: string;
  exec: ExecAndRecOut;
  compsHtml: string;
  precedentsHtml: string;
  lboHtml: string;
}

function renderPitchBookHtml(args: RenderArgs): string {
  const { target, focus, exec, compsHtml, precedentsHtml, lboHtml } = args;

  const cover = `<div class="memo-rec-banner">
    <div class="memo-rec-label">PITCH BOOK</div>
    <div class="memo-rec-headline">${escape(target)}</div>
    <div class="memo-rec-conviction">${escape(focus.replace(/_/g, ' ').toUpperCase())} · PREPARED BY COMPASS</div>
  </div>`;

  const overview = `${section('Situation Overview')}<p>${escape(exec.situation_overview)}</p>`;

  const keyMetricsTable = table({
    headers: ['Metric', 'Value', 'Context'],
    rows: exec.key_metrics.map(m => [m.label, m.value, m.note ?? '']),
    numericColumns: [1],
  });

  const thesisHtml = `${section('Investment Thesis')}<ol class="memo-numbered">${exec.thesis_points
    .map(t => `<li><strong>${escape(t.headline)}.</strong> ${escape(t.body)}</li>`)
    .join('')}</ol>`;

  const actionHtml = `${section('Recommended Action')}
    <p><strong>${escape(exec.recommended_action.headline)}.</strong> ${escape(exec.recommended_action.rationale)}</p>
    <ul class="memo-bullets">${exec.recommended_action.next_steps.map(s => `<li>→ ${escape(s)}</li>`).join('')}</ul>`;

  return [
    cover,
    overview,
    section('Key Metrics'),
    keyMetricsTable,
    thesisHtml,
    section('Trading Comparables'),
    compsHtml,
    section('Precedent Transactions'),
    precedentsHtml,
    lboHtml ? section('Sponsor LBO Scenario') : '',
    lboHtml,
    actionHtml,
    note(`<strong>Compass note:</strong> Pitch book composed of model-grounded comps, precedents, and an illustrative LBO. For a precise LBO, run "Build LBO model on ${escape(target)} at $X EV" as a separate task.`),
  ].filter(Boolean).join('\n');
}
