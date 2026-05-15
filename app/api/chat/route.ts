import { NextRequest } from 'next/server';
import { runChatAgent } from '@/lib/agents/chat_agent';
import { clarifyScope, type ClarifyOutput, type ClarifyQuestion } from '@/lib/agents/clarify';
import { detectFollowUp } from '@/lib/agents/follow_up';
import { extractParameters, buildAcknowledgement, type AcknowledgementPill } from '@/lib/agents/parameter_extractor';
import { manifestFor } from '@/lib/manifests';
import type { TaskType, ParamSpec } from '@/lib/manifests/types';
import { streamConversationalAsk, buildLockedInLine } from '@/lib/agents/conversational_clarify';
import { runLBOPipeline, type LBOScope } from '@/lib/agents/deliverables/lbo_pipeline';
import { runTradingCompsPipeline, type TradingCompsScope } from '@/lib/agents/deliverables/trading_comps';
import { runIPOValuationPipeline, type IPOValuationScope } from '@/lib/agents/deliverables/ipo_valuation';
import { runBondPricingPipeline, type BondPricingScope } from '@/lib/agents/deliverables/bond_pricing';
import { runPrecedentsPipeline, type PrecedentsScope } from '@/lib/agents/deliverables/precedents';
import { runICMemoPipeline, type ICMemoScope } from '@/lib/agents/deliverables/ic_memo';
import { runPitchBookPipeline, type PitchBookScope } from '@/lib/agents/deliverables/pitch_book';
import { runDCFPipeline, type DCFScope } from '@/lib/agents/deliverables/dcf';
import { runFootballFieldPipeline, type FootballFieldScope } from '@/lib/agents/deliverables/football_field';
import { runMonteCarloPipeline, type MonteCarloScope } from '@/lib/agents/deliverables/monte_carlo';
import type { DeliverableEvent, InputTrace } from '@/lib/agents/deliverables/shared';
import { computeConfidence } from '@/lib/agents/deliverables/confidence';
import { auditCitations, fingerprintRun } from '@/lib/agents/deliverables/citation_audit';
import { scanNumericLeaks } from '@/lib/agents/deliverables/numeric_gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface ScopeAnswers {
  [questionId: string]: string | number | boolean | string[];
}

interface Body {
  query?: string;
  /** When set, chat skips clarification and runs the agent with these answers folded into the prompt. */
  scope?: ScopeAnswers;
  /** Original task type from a previous clarify call — used to format the agent prompt. */
  task_type?: string;
  /** Target identified during clarify; passed through to deliverable pipelines. */
  detected_target?: { name: string; ticker?: string } | null;
  /** Skip clarify regardless. Used for plain chat queries the caller knows are not deliverable-driven. */
  skip_clarify?: boolean;
  /** Most-recently-completed deliverable context. When the new query is a follow-up
   *  ("re-run with $11B"), the chat reuses this and applies the new query as overrides. */
  prior_context?: {
    task_type: string;
    detected_target: { name: string; ticker?: string } | null;
    scope: Record<string, string | number | boolean | string[]>;
  } | null;
  /** Recent conversation turns — passed to the parameter extractor for cross-turn signals. */
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** When the prior turn ended in a conversational ask (LBO only for now), the
   *  client echoes this back. The current `query` is treated as the user's
   *  reply: we re-run extraction against the manifest, merge with partial_scope,
   *  and either re-ask or run the deliverable. */
  pending_clarification?: {
    task_type: string;
    detected_target: { name: string; ticker?: string } | null;
    partial_scope: Record<string, string | number | boolean | string[]>;
  } | null;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as Body;
  const query = body.query?.trim();
  if (!query) {
    return new Response(JSON.stringify({ error: 'query is required' }), { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: object) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        } catch {
          closed = true;
        }
      };
      const closeOnce = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };

      try {
        emit({ type: 'started', query });

        // ----- LBO conversational continuation -----
        // The user is replying to a prior conversational ask (LBO only for now).
        // Re-extract against the LBO manifest, merge with partial scope, and
        // either re-ask conversationally or fall through to the LBO pipeline.
        if (body.pending_clarification && body.pending_clarification.task_type === 'lbo') {
          const handled = await handleLBOContinuation(body, query, emit);
          if (handled.terminal) return;
          // Otherwise, scope/task_type/detected_target are now populated on
          // body — fall through to the deliverable router below.
        }

        const hasScope = body.scope && Object.keys(body.scope).length > 0;

        // ----- Follow-up fast path -----
        // If the user has prior context AND the new query reads like a tweak
        // ("re-run with $11B", "what if leverage is 7x", "same but Apple"),
        // skip clarify and run the prior deliverable with merged scope.
        if (!hasScope && !body.skip_clarify && body.prior_context) {
          const priorTargetName = body.prior_context.detected_target?.name ?? null;
          const followUp = await detectFollowUp(query, priorTargetName);
          if (followUp.isFollowUp) {
            const priorTaskType = body.prior_context.task_type as TaskType;
            const manifest = manifestFor(priorTaskType);
            // Run extractor on the follow-up text against the prior task's manifest
            // to pick up parameter overrides like "$11B" or "leverage to 7x".
            let overrides: Record<string, string | number | boolean | string[]> = {};
            try {
              const extraction = await extractParameters({
                query,
                manifest,
                history: body.history,
              });
              for (const e of extraction.extracted) {
                overrides[e.paramId] = e.value;
              }
            } catch {
              overrides = {};
            }
            const mergedScope = { ...body.prior_context.scope, ...overrides };
            const targetForRun = followUp.newTarget
              ? { name: followUp.newTarget.name, ticker: followUp.newTarget.ticker }
              : body.prior_context.detected_target;

            emit({
              type: 'classified',
              task_type: priorTaskType,
              asset_class: 'unknown',
              detected_target: targetForRun,
              acknowledged_pills: [
                {
                  paramId: 'follow_up',
                  label: `Reusing ${manifest.label}${targetForRun?.name ? ' on ' + targetForRun.name : ''}${followUp.newTarget ? ` (switched from ${priorTargetName})` : ''}`,
                  source: 'conversation_history' as const,
                },
                ...Object.entries(overrides).map(([k, v]) => ({
                  paramId: k,
                  label: `${k} → ${formatScopeVal(v)}`,
                  source: 'current_prompt' as const,
                })),
              ],
            });

            body.scope = mergedScope as ScopeAnswers;
            body.task_type = priorTaskType;
            body.detected_target = targetForRun;
          }
        }

        const hasScopeAfterFollowUp = body.scope && Object.keys(body.scope).length > 0;
        if (!hasScopeAfterFollowUp && !body.skip_clarify) {
          emit({ type: 'clarifying' });
          let scope: ClarifyOutput | null = null;
          try {
            scope = await clarifyScope(query, {
              history: body.history,
              priorContext: body.prior_context ?? null,
            });
          } catch (err) {
            emit({ type: 'clarify_error', error: err instanceof Error ? err.message : 'clarify failed' });
          }

          if (scope && !scope.ready_to_proceed && scope.questions.length > 0) {
            // LBO uses the conversational path — stream the ask as chat tokens
            // and emit pending_clarification for the next turn. Other task
            // types still get the form card.
            if (scope.task_type === 'lbo') {
              const lboManifest = manifestFor('lbo');
              const filledIds = new Set(Object.keys(scope.acknowledged_scope));
              const missingParams: ParamSpec[] = [...lboManifest.required, ...lboManifest.recommended]
                .filter(p => !filledIds.has(p.id) && !LBO_AUTO_DEFAULT_PARAMS.has(p.id));

              if (missingParams.length === 0) {
                // Everything user-facing already in the prompt — auto-default
                // the rest and route straight to the LBO pipeline.
                const fullScope = applyLBOAutoDefaults(scope.acknowledged_scope);
                emit({
                  type: 'classified',
                  task_type: 'lbo',
                  asset_class: scope.asset_class,
                  detected_target: scope.detected_target,
                  acknowledged_pills: scope.acknowledged_pills,
                });
                const lockedLine = buildLockedInLine({
                  manifest: lboManifest,
                  detectedTarget: scope.detected_target,
                  scope: fullScope,
                });
                emit({ type: 'token', text: `<div class="compass-chat-block">${escapeHtmlForChat(lockedLine)}</div>` });
                body.scope = fullScope as ScopeAnswers;
                body.task_type = 'lbo';
                body.detected_target = scope.detected_target;
                // Fall through to deliverable router below.
              } else {
                emit({
                  type: 'classified',
                  task_type: scope.task_type,
                  asset_class: scope.asset_class,
                  detected_target: scope.detected_target,
                  acknowledged_pills: scope.acknowledged_pills,
                });
                await streamLBOConversationalAsk({
                  manifest: lboManifest,
                  detectedTarget: scope.detected_target,
                  acknowledgedPills: scope.acknowledged_pills,
                  missingParams,
                  isContinuation: false,
                  emit,
                });
                emit({
                  type: 'pending_clarification',
                  task_type: 'lbo',
                  detected_target: scope.detected_target,
                  partial_scope: scope.acknowledged_scope,
                });
                emit({ type: 'done', latencyMs: 0 });
                return;
              }
            }
            emit({
              type: 'clarification',
              task_type: scope.task_type,
              asset_class: scope.asset_class,
              detected_target: scope.detected_target,
              preface: scope.preface,
              questions: scope.questions,
              acknowledged_scope: scope.acknowledged_scope,
              acknowledged_pills: scope.acknowledged_pills,
            });
            emit({ type: 'done', latencyMs: 0 });
            return;
          }
          // ready_to_proceed = true (everything was extracted from the prompt or no clarification needed).
          // Merge any extracted scope into the body so the deliverable pipeline gets it.
          if (scope) {
            emit({
              type: 'classified',
              task_type: scope.task_type,
              asset_class: scope.asset_class,
              detected_target: scope.detected_target,
              acknowledged_pills: scope.acknowledged_pills,
            });
            if (Object.keys(scope.acknowledged_scope).length > 0) {
              body.scope = { ...(scope.acknowledged_scope as ScopeAnswers), ...(body.scope ?? {}) };
              body.task_type = scope.task_type;
              body.detected_target = scope.detected_target ?? body.detected_target;
            }
          }
        }

        // Route deliverable task types to dedicated pipelines.
        const deliverable = pickDeliverableGenerator(body, query);
        if (deliverable) {
          // Emit the deliverable context so the UI can carry it as
          // prior_context for any follow-up tweaks ("re-run with $11B").
          emit({
            type: 'deliverable_context',
            task_type: body.task_type,
            detected_target: body.detected_target ?? null,
            scope: body.scope ?? {},
          });
          // Buffer the input trace and sources so we can compute citation
          // accuracy once both have streamed — pipelines emit them in
          // different orders.
          const buffered: { inputs?: InputTrace[]; sources?: Array<{ n: number; title: string; url: string | null; meta: string }>; modelInputs?: Record<string, unknown> } = {};
          let auditEmitted = false;
          const tryEmitAudit = () => {
            if (auditEmitted) return;
            if (!buffered.inputs || !buffered.sources) return;
            const audit = auditCitations(buffered.inputs, buffered.sources);
            emit({ type: 'citation_audit', deliverable: deliverable.label, ...audit });
            auditEmitted = true;
          };
          for await (const event of deliverable.gen) {
            relayDeliverableEvent(event, deliverable.label, emit);
            const ev = event as { type: string; inputs?: unknown; sources?: unknown; text?: string };
            if (ev.type === 'inputs_resolved' && ev.inputs && typeof ev.inputs === 'object' && !Array.isArray(ev.inputs)) {
              // LBO and DCF emit inputs_resolved with the full pure-function
              // input object (entryEV, initialRevenue, ebitdaMargin, etc.).
              // Capture it so Monte Carlo follow-ups can overlay this run.
              buffered.modelInputs = ev.inputs as Record<string, unknown>;
            }
            if (ev.type === 'inputs_traced' && Array.isArray(ev.inputs)) {
              buffered.inputs = ev.inputs as InputTrace[];
              tryEmitAudit();
            } else if (ev.type === 'sources' && Array.isArray(ev.sources)) {
              buffered.sources = ev.sources as Array<{ n: number; title: string; url: string | null; meta: string }>;
              tryEmitAudit();
            } else if (ev.type === 'token' && typeof ev.text === 'string') {
              // Numeric sanity gate — never let NaN / Infinity / undefined
              // leak into the deliverable as a "fact". This is the last
              // line of defense after preflight + validators + model guards.
              const leaks = scanNumericLeaks(ev.text);
              if (leaks.length > 0) {
                emit({ type: 'hallucination_gate', deliverable: deliverable.label, leaks });
              }
            }
          }
          // After the run, re-emit deliverable_context with the underlying
          // model's pure-function inputs folded into scope under reserved
          // `_model_*` keys. Monte Carlo (a follow-up overlay) reads these
          // to rebuild the base inputs without preflighting XBRL again.
          if (buffered.modelInputs) {
            const augmentedScope = { ...(body.scope ?? {}) } as Record<string, unknown>;
            for (const [k, v] of Object.entries(buffered.modelInputs)) {
              augmentedScope[`_model_${k}`] = v;
            }
            emit({
              type: 'deliverable_context',
              task_type: body.task_type,
              detected_target: body.detected_target ?? null,
              scope: augmentedScope,
            });
          }
          return;
        }

        const agentInput = hasScope
          ? buildScopedQuery(query, body.scope!, body.task_type)
          : query;

        for await (const event of runChatAgent(agentInput, {
          history: body.history,
          priorContext: body.prior_context
            ? {
                detectedTarget: body.prior_context.detected_target,
                taskType: body.prior_context.task_type,
              }
            : null,
        })) {
          emit(event);
        }
      } catch (err) {
        emit({ type: 'error', error: err instanceof Error ? err.message : 'unknown error' });
        emit({ type: 'done', latencyMs: 0 });
      } finally {
        closeOnce();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

function pickDeliverableGenerator(
  body: Body,
  query: string,
): { label: string; gen: AsyncGenerator<DeliverableEvent, void> } | null {
  const detectedTarget = body.detected_target ?? null;
  const scope = (body.scope ?? {}) as Record<string, unknown>;
  const hasScope = Object.keys(scope).length > 0;
  const tt = body.task_type;
  if (!tt) return null;
  // Most deliverables require scope answers. Excel export is the exception:
  // it has no scope card — the export is driven entirely off prior_context.
  if (tt !== 'excel_model' && !hasScope) return null;

  switch (tt) {
    case 'lbo':
    case 'lbo_analysis':
      return {
        label: 'lbo_pipeline',
        gen: runLBOPipeline({ query, scope: scope as LBOScope, detectedTarget }) as unknown as AsyncGenerator<DeliverableEvent, void>,
      };
    case 'trading_comps':
      return { label: 'trading_comps', gen: runTradingCompsPipeline({ query, scope: scope as TradingCompsScope, detectedTarget }) };
    case 'ipo_valuation':
    case 'ipo_pricing':
      return { label: 'ipo_valuation', gen: runIPOValuationPipeline({ query, scope: scope as IPOValuationScope, detectedTarget }) };
    case 'bond_pricing':
      return { label: 'bond_pricing', gen: runBondPricingPipeline({ query, scope: scope as BondPricingScope, detectedTarget }) };
    case 'ic_memo':
      return { label: 'ic_memo', gen: runICMemoPipeline({ query, scope: scope as ICMemoScope, detectedTarget }) };
    case 'pitch_book':
      return { label: 'pitch_book', gen: runPitchBookPipeline({ query, scope: scope as PitchBookScope, detectedTarget }) };
    case 'precedents':
      return { label: 'precedents', gen: runPrecedentsPipeline({ query, scope: scope as PrecedentsScope, detectedTarget }) };
    case 'dcf':
      return { label: 'dcf', gen: runDCFPipeline({ query, scope: scope as DCFScope, detectedTarget }) };
    case 'football_field':
      return { label: 'football_field', gen: runFootballFieldPipeline({ query, scope: scope as FootballFieldScope, detectedTarget }) };
    case 'monte_carlo':
      return {
        label: 'monte_carlo',
        gen: runMonteCarloPipeline({
          query,
          scope: scope as MonteCarloScope,
          detectedTarget,
          priorContext: body.prior_context ?? null,
        }),
      };
    case 'excel_model':
      return {
        label: 'excel_model',
        gen: excelExportAction(body),
      };
    default:
      return null;
  }
}

/**
 * Excel-export is a download, not a streaming chat answer. The "deliverable"
 * the chat emits is an action card pointing at the binary endpoint and
 * surfacing what's about to be exported. The user clicks to download.
 *
 * Requires prior_context to carry _model_* keys (LBO or DCF). Otherwise
 * refuses with a clean explanation of what's missing.
 */
async function* excelExportAction(body: Body): AsyncGenerator<DeliverableEvent, void> {
  const prior = body.prior_context;
  const supported: Record<string, true> = { lbo: true, lbo_analysis: true, dcf: true };
  if (!prior || !supported[prior.task_type]) {
    yield {
      type: 'token',
      text: `<div class="memo-rec-banner" style="border-left-color:#fbbf24">
        <div class="memo-rec-label" style="color:#fbbf24">EXCEL EXPORT NEEDS A SOURCE MODEL</div>
        <div class="memo-rec-headline">Run an LBO or DCF first, then ask "export to Excel".</div>
      </div>
      <p>Excel export packages a completed LBO or DCF run as a downloadable .xlsx — Inputs / Model / Outputs / Sensitivity / Sources tabs with citations as cell comments. It needs the prior model's inputs in conversation context to know what to export.</p>
      <p class="memo-disclaimer">Trading comps, precedents, IC memo, and pitch book export aren't wired yet — the static-value workbook only covers numeric models for now.</p>`,
    };
    yield { type: 'done' };
    return;
  }
  const rawTask = prior.task_type === 'lbo_analysis' ? 'lbo' : prior.task_type;
  const exportPayload = {
    task_type: rawTask,
    detected_target: prior.detected_target,
    scope: prior.scope,
  };
  const exportBody = JSON.stringify(exportPayload);
  const dataUri = `data:application/json;base64,${Buffer.from(exportBody).toString('base64')}`;
  const targetLabel = prior.detected_target?.name
    ? `${prior.detected_target.name}${prior.detected_target.ticker ? ` (${prior.detected_target.ticker})` : ''}`
    : 'this model';
  const filename = `${(prior.detected_target?.name ?? 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${rawTask}-${new Date().toISOString().slice(0, 10)}.xlsx`;

  // Workbook contents summary — what the user can expect inside the file.
  const tabsList = `<ul class="memo-bullets">
    <li><strong>Inputs</strong> — every input with origin (sourced / user / default) and source as a cell comment</li>
    <li><strong>Model</strong> — ${rawTask === 'lbo' ? 'year-by-year debt schedule (revenue, EBITDA, capex, FCF, interest, principal, debt balance)' : 'projection table (revenue, EBIT, taxed EBIT, capex, FCF, discount factor, PV(FCF))'}</li>
    <li><strong>Outputs</strong> — ${rawTask === 'lbo' ? 'sources &amp; uses, exit math, IRR, MOIC' : 'sum of PV(FCF), terminal value, enterprise value, EV/Revenue + EV/EBIT crosschecks'}</li>
    <li><strong>Sensitivity</strong> — ${rawTask === 'lbo' ? 'Exit multiple × Revenue CAGR → IRR grid' : 'WACC × terminal growth → EV grid'}</li>
    <li><strong>Sources</strong> — full citation list</li>
  </ul>`;

  yield {
    type: 'token',
    text: `<div class="memo-rec-banner">
      <div class="memo-rec-label">EXCEL EXPORT READY</div>
      <div class="memo-rec-headline">${targetLabel} · ${rawTask.toUpperCase()} · static-value workbook</div>
    </div>
    <p>Click the button below to download <code>${filename}</code>. The workbook contains:</p>
    ${tabsList}
    <p><button class="excel-export-btn" data-payload="${dataUri}" data-filename="${filename}">↓ Download .xlsx</button></p>
    <p class="memo-disclaimer">Static values only — no live formulas in cells. Re-running the underlying model with new inputs requires a fresh export.</p>`,
  };

  yield {
    type: 'inputs_traced',
    inputs: [
      { field: 'export_format', label: 'Export format', value: 'Static-value .xlsx (SheetJS)', origin: 'default', sourceRef: 'Compass Excel exporter' },
      { field: 'source_model', label: 'Source model', value: rawTask.toUpperCase(), origin: 'sourced', sourceRef: 'Prior run in this conversation', citationN: 1 },
      { field: 'target', label: 'Target', value: targetLabel, origin: 'sourced', sourceRef: prior.detected_target?.ticker ? `SEC ticker ${prior.detected_target.ticker}` : 'Curated entity', citationN: 1 },
      { field: 'tabs', label: 'Workbook tabs', value: 'Inputs / Model / Outputs / Sensitivity / Sources', origin: 'default', sourceRef: 'Static layout' },
    ],
  };
  const priorRunId = fingerprintRun(rawTask, prior.scope as Record<string, unknown>);
  yield {
    type: 'sources',
    sources: [{
      n: 1,
      title: `${targetLabel} prior ${rawTask.toUpperCase()} run`,
      url: null,
      meta: `Base inputs and computed outputs are sourced from the conversation's prior model run (runId ${priorRunId})`,
      kind: 'prior_run' as const,
      runId: priorRunId,
    }],
  };
  yield { type: 'done' };
}

interface RelayEmit {
  (event: object): void;
}

function relayDeliverableEvent(event: unknown, label: string, emit: RelayEmit): void {
  // Accept either DeliverableEvent shape or LBOPipelineEvent shape.
  const ev = event as { type: string; step?: string; text?: string; sources?: Array<{ n: number; title: string; url: string | null; meta: string }>; error?: string; inputs?: Record<string, unknown> | unknown[] };
  if (ev.type === 'progress') emit({ type: 'tool_result', name: label, summary: ev.step ?? '' });
  else if (ev.type === 'inputs_resolved') {
    const i = ev.inputs as { entryEV?: number; leverageMultiple?: number; holdPeriod?: number; exitMultiple?: number } | undefined;
    if (i) emit({ type: 'tool_result', name: label, summary: `Inputs: entry $${i.entryEV}M · ${i.leverageMultiple}x leverage · ${i.holdPeriod}y hold · ${i.exitMultiple}x exit` });
  }
  else if (ev.type === 'inputs_traced') {
    const inputs = (ev.inputs ?? []) as InputTrace[];
    emit({ type: 'inputs_traced', deliverable: label, inputs });
    const conf = computeConfidence(inputs);
    emit({ type: 'confidence', deliverable: label, score: conf.score, breakdown: conf.breakdown });
  }
  else if (ev.type === 'calc_steps') {
    emit({ type: 'calc_steps', deliverable: label, calc: (ev as { calc?: unknown }).calc });
  }
  else if (ev.type === 'sources') {
    emit({ type: 'sources', sources: ev.sources?.map(s => ({ ...s, source: 'compass_internal', docType: label, filedAt: null, isPrimary: false, similarity: 1 })) });
  }
  else if (ev.type === 'token') emit({ type: 'token', text: ev.text });
  else if (ev.type === 'done') emit({ type: 'done', latencyMs: 0 });
  else if (ev.type === 'error') emit({ type: 'error', error: ev.error });
}

function formatScopeVal(v: string | number | boolean | string[]): string {
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number' && Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}B`;
  return String(v);
}

interface EmitFn { (event: object): void }

/** LBO params that can be silently defaulted from the manifest if the user
 *  doesn't mention them — keeps the conversational ask short (5 vs 7 lines).
 *  The pipeline still surfaces validator warnings if the defaults are off. */
const LBO_AUTO_DEFAULT_PARAMS = new Set(['revenue_cagr', 'margin_trajectory']);

function applyLBOAutoDefaults(
  scope: Record<string, string | number | boolean | string[]>,
): Record<string, string | number | boolean | string[]> {
  const merged = { ...scope };
  const m = manifestFor('lbo');
  for (const p of [...m.required, ...m.recommended]) {
    if (LBO_AUTO_DEFAULT_PARAMS.has(p.id) && !(p.id in merged) && p.default !== undefined) {
      merged[p.id] = p.default as string | number | boolean | string[];
    }
  }
  return merged;
}

/**
 * The user is replying to a prior LBO conversational ask. Re-run extraction
 * against the LBO manifest with their reply + history, merge the new params
 * into the partial scope, and decide whether we have enough to run.
 *
 * Returns { terminal: true } if the response stream is finished here (we
 * re-asked and emitted done). Returns { terminal: false } after mutating
 * `body` so the caller can fall through to the deliverable router.
 */
async function handleLBOContinuation(
  body: Body,
  query: string,
  emit: EmitFn,
): Promise<{ terminal: boolean }> {
  const pending = body.pending_clarification!;
  const manifest = manifestFor('lbo');

  let extraction;
  try {
    extraction = await extractParameters({
      query,
      manifest,
      history: body.history,
    });
  } catch {
    extraction = { extracted: [], ambiguous: [], inferredContext: {} };
  }

  // Merge: prior partial + freshly extracted (new wins on conflict — the
  // user is explicitly answering, so trust the latest reply).
  const mergedScope: Record<string, string | number | boolean | string[]> = {
    ...pending.partial_scope,
  };
  for (const e of extraction.extracted) {
    mergedScope[e.paramId] = e.value;
  }

  // Determine what's still missing — skip params we'll silently default.
  const filledIds = new Set(Object.keys(mergedScope));
  const missingRequired = manifest.required.filter(p => !filledIds.has(p.id) && !LBO_AUTO_DEFAULT_PARAMS.has(p.id));
  const missingRecommended = manifest.recommended.filter(p => !filledIds.has(p.id) && !LBO_AUTO_DEFAULT_PARAMS.has(p.id));
  const missing = [...missingRequired, ...missingRecommended];

  if (missing.length === 0) {
    // Apply auto-defaults so the LBO pipeline gets a complete scope.
    const fullScope = applyLBOAutoDefaults(mergedScope);
    // Full scope. Emit a lock-in line, then let the caller route to the LBO
    // pipeline by populating body.scope / body.task_type / body.detected_target.
    emit({
      type: 'classified',
      task_type: 'lbo',
      asset_class: 'private_equity',
      detected_target: pending.detected_target,
      acknowledged_pills: extraction.extracted.map(e => ({
        paramId: e.paramId,
        label: `${e.paramId} → ${formatScopeVal(e.value)}`,
        source: 'current_prompt' as const,
      })),
    });
    const lockedLine = buildLockedInLine({
      manifest,
      detectedTarget: pending.detected_target,
      scope: fullScope,
    });
    emit({ type: 'token', text: `<div class="compass-chat-block">${escapeHtmlForChat(lockedLine)}</div>` });
    body.scope = fullScope as ScopeAnswers;
    body.task_type = 'lbo';
    body.detected_target = pending.detected_target ?? null;
    return { terminal: false };
  }

  // Still missing — re-ask conversationally and emit a fresh pending state.
  // Re-build acknowledgement pills using both prior + freshly-extracted params.
  const allExtracted = [
    ...Object.entries(pending.partial_scope).map(([paramId, value]) => ({
      paramId,
      value,
      source: 'conversation_history' as const,
      confidence: 0.9,
      originalText: '(from earlier in the chat)',
    })),
    ...extraction.extracted,
  ];
  const pills = buildAcknowledgement(
    { extracted: allExtracted, ambiguous: extraction.ambiguous, inferredContext: extraction.inferredContext },
    manifest,
  );

  emit({
    type: 'classified',
    task_type: 'lbo',
    asset_class: 'private_equity',
    detected_target: pending.detected_target,
    acknowledged_pills: pills,
  });
  await streamLBOConversationalAsk({
    manifest,
    detectedTarget: pending.detected_target,
    acknowledgedPills: pills,
    missingParams: missing,
    isContinuation: true,
    emit,
  });
  emit({
    type: 'pending_clarification',
    task_type: 'lbo',
    detected_target: pending.detected_target,
    partial_scope: mergedScope,
  });
  emit({ type: 'done', latencyMs: 0 });
  return { terminal: true };
}

/** Wrap a streamed plain-text message in a div whose CSS preserves newlines.
 *  Emitted as opener/closer tokens around the streamed body so the
 *  content lands in the chat bubble as one block with line breaks intact. */
const PRE_LINE_OPEN = '<div class="compass-chat-block">';
const PRE_LINE_CLOSE = '</div>';

async function streamLBOConversationalAsk(args: {
  manifest: ReturnType<typeof manifestFor>;
  detectedTarget: { name: string; ticker?: string } | null;
  acknowledgedPills: AcknowledgementPill[];
  missingParams: ParamSpec[];
  isContinuation: boolean;
  emit: EmitFn;
}): Promise<void> {
  args.emit({ type: 'token', text: PRE_LINE_OPEN });
  // Defensive: if Sonnet streaming fails, fall back to a deterministic
  // template so the user still sees the ask. Better one mediocre message
  // than a stuck stream.
  let emittedAny = false;
  try {
    const stream = streamConversationalAsk({
      manifest: args.manifest,
      detectedTarget: args.detectedTarget,
      acknowledgedPills: args.acknowledgedPills,
      missingParams: args.missingParams,
      isContinuation: args.isContinuation,
    });
    for await (const event of stream) {
      // HTML-escape token text so the assistant bubble doesn't try to render
      // any incidental angle brackets Sonnet produces.
      const safe = escapeHtmlForChat(event.text);
      args.emit({ type: 'token', text: safe });
      emittedAny = true;
    }
  } catch (err) {
    args.emit({ type: 'tool_result', name: 'conversational_clarify', summary: `Sonnet stream failed: ${err instanceof Error ? err.message : 'unknown'}; using fallback` });
  }
  if (!emittedAny) {
    const target = args.detectedTarget?.name ?? args.manifest.label;
    const ack = args.acknowledgedPills.length > 0
      ? `I have ${args.acknowledgedPills.map(p => p.label).join(', ')} from your prompt. `
      : '';
    const lines = args.missingParams.map((p, i) => `${i + 1}. ${p.label}${p.hint ? ` (${p.hint})` : ''}`);
    const text = args.isContinuation
      ? `Still need:\n\n${lines.join('\n')}\n\nAnswer in any order.\n`
      : `Got it — ${target} LBO. ${ack}${args.missingParams.length} parameter${args.missingParams.length === 1 ? '' : 's'} before I build:\n\n${lines.join('\n')}\n\nAnswer in any order — natural language is fine.\n`;
    args.emit({ type: 'token', text: escapeHtmlForChat(text) });
  }
  args.emit({ type: 'token', text: PRE_LINE_CLOSE });
}

function escapeHtmlForChat(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildScopedQuery(query: string, scope: ScopeAnswers, taskType?: string): string {
  const lines: string[] = [`User task: ${query}`];
  if (taskType) lines.push(`Task type: ${taskType}`);
  lines.push('');
  lines.push('Scope (answers from the clarification step — treat as binding parameters when researching):');
  for (const [k, v] of Object.entries(scope)) {
    const value = Array.isArray(v) ? v.join(', ') : String(v);
    lines.push(`  - ${k}: ${value}`);
  }
  return lines.join('\n');
}

export type { ClarifyQuestion };
