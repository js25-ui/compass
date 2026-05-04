import { NextRequest } from 'next/server';
import { runChatAgent } from '@/lib/agents/chat_agent';
import { clarifyScope, type ClarifyOutput, type ClarifyQuestion } from '@/lib/agents/clarify';
import { detectFollowUp } from '@/lib/agents/follow_up';
import { extractParameters } from '@/lib/agents/parameter_extractor';
import { manifestFor } from '@/lib/manifests';
import type { TaskType } from '@/lib/manifests/types';
import { runLBOPipeline, type LBOScope } from '@/lib/agents/deliverables/lbo_pipeline';
import { runTradingCompsPipeline, type TradingCompsScope } from '@/lib/agents/deliverables/trading_comps';
import { runIPOValuationPipeline, type IPOValuationScope } from '@/lib/agents/deliverables/ipo_valuation';
import { runBondPricingPipeline, type BondPricingScope } from '@/lib/agents/deliverables/bond_pricing';
import { runPrecedentsPipeline, type PrecedentsScope } from '@/lib/agents/deliverables/precedents';
import { runICMemoPipeline, type ICMemoScope } from '@/lib/agents/deliverables/ic_memo';
import { runPitchBookPipeline, type PitchBookScope } from '@/lib/agents/deliverables/pitch_book';
import type { DeliverableEvent } from '@/lib/agents/deliverables/shared';

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
            scope = await clarifyScope(query);
          } catch (err) {
            emit({ type: 'clarify_error', error: err instanceof Error ? err.message : 'clarify failed' });
          }

          if (scope && !scope.ready_to_proceed && scope.questions.length > 0) {
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
          for await (const event of deliverable.gen) {
            relayDeliverableEvent(event, deliverable.label, emit);
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

  // Task-type names come from the manifest registry now. Both the new
  // canonical names ('lbo', 'ipo_valuation') and the legacy names
  // ('lbo_analysis', 'ipo_pricing') are accepted so direct API calls
  // from earlier consumers don't break silently.
  if ((tt === 'lbo' || tt === 'lbo_analysis') && hasScope) {
    return {
      label: 'lbo_pipeline',
      gen: runLBOPipeline({ query, scope: scope as LBOScope, detectedTarget }) as unknown as AsyncGenerator<DeliverableEvent, void>,
    };
  }
  if (tt === 'trading_comps') {
    return {
      label: 'trading_comps',
      gen: runTradingCompsPipeline({ query, scope: scope as TradingCompsScope, detectedTarget }),
    };
  }
  if (tt === 'ipo_valuation' || tt === 'ipo_pricing') {
    return {
      label: 'ipo_valuation',
      gen: runIPOValuationPipeline({ query, scope: scope as IPOValuationScope, detectedTarget }),
    };
  }
  if (tt === 'bond_pricing') {
    return {
      label: 'bond_pricing',
      gen: runBondPricingPipeline({ query, scope: scope as BondPricingScope, detectedTarget }),
    };
  }
  if (tt === 'ic_memo') {
    return {
      label: 'ic_memo',
      gen: runICMemoPipeline({ query, scope: scope as ICMemoScope, detectedTarget }),
    };
  }
  if (tt === 'pitch_book') {
    return {
      label: 'pitch_book',
      gen: runPitchBookPipeline({ query, scope: scope as PitchBookScope, detectedTarget }),
    };
  }
  // Precedents shows up as a "task_type" only via direct API; clarify routes it through chat_answer.
  return null;
}

interface RelayEmit {
  (event: object): void;
}

function relayDeliverableEvent(event: unknown, label: string, emit: RelayEmit): void {
  // Accept either DeliverableEvent shape or LBOPipelineEvent shape.
  const ev = event as { type: string; step?: string; text?: string; sources?: Array<{ n: number; title: string; url: string | null; meta: string }>; error?: string; inputs?: Record<string, unknown> };
  if (ev.type === 'progress') emit({ type: 'tool_result', name: label, summary: ev.step ?? '' });
  else if (ev.type === 'inputs_resolved') {
    const i = ev.inputs as { entryEV?: number; leverageMultiple?: number; holdPeriod?: number; exitMultiple?: number } | undefined;
    if (i) emit({ type: 'tool_result', name: label, summary: `Inputs: entry $${i.entryEV}M · ${i.leverageMultiple}x leverage · ${i.holdPeriod}y hold · ${i.exitMultiple}x exit` });
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
