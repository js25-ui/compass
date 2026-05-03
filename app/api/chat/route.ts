import { NextRequest } from 'next/server';
import { runChatAgent } from '@/lib/agents/chat_agent';
import { clarifyScope, type ClarifyOutput, type ClarifyQuestion } from '@/lib/agents/clarify';

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
  /** Skip clarify regardless. Used for plain chat queries the caller knows are not deliverable-driven. */
  skip_clarify?: boolean;
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

        if (!hasScope && !body.skip_clarify) {
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
            });
            emit({ type: 'done', latencyMs: 0 });
            return;
          }
          if (scope) {
            emit({
              type: 'classified',
              task_type: scope.task_type,
              asset_class: scope.asset_class,
              detected_target: scope.detected_target,
            });
          }
        }

        const agentInput = hasScope
          ? buildScopedQuery(query, body.scope!, body.task_type)
          : query;

        for await (const event of runChatAgent(agentInput)) {
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
