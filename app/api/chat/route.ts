import { NextRequest } from 'next/server';
import { orchestrate } from '@/lib/agents/orchestrator';
import { detectCategory, type DetectedCategory } from '@/lib/agents/categories';
import { streamSonnet } from '@/lib/llm/anthropic';
import { MEMO_AGENT_PROMPT } from '@/lib/llm/prompts';
import { listIndexedEntities, recentCorpusSnapshot, searchChunks, type RetrievedChunk } from '@/lib/retrieval/vector_search';
import { ingestEntity } from '@/lib/ingest/pipeline';
import { getTargetSnapshot } from '@/lib/ingest/persist';
import { resolveEntity, type ResolvedEntity } from '@/lib/lookup/resolve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const INGEST_BUDGET_MS = 25_000;        // hard cap so chat finishes inside 60s
const TOP_K = 8;

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { query?: string };
  const query = body.query?.trim();
  if (!query) {
    return new Response(JSON.stringify({ error: 'query is required' }), { status: 400 });
  }

  const encoder = new TextEncoder();
  const startedAt = Date.now();

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
        try { closeOnce(); } catch { /* already closed */ }
      };

      try {
        emit({ type: 'started', query });

        // 1. Orchestrator: extract + resolve entities
        emit({ type: 'extracting' });
        const result = await orchestrate(query);
        emit({
          type: 'extracted',
          entities: result.resolved.map(e => ({ id: e.id, name: e.name, ticker: e.ticker })),
          unresolved: result.unresolved,
          intent: result.intent,
          isHistorical: result.isHistorical,
        });

        if (result.needsClarification) {
          emit({ type: 'clarification_suppressed', question: result.clarificationQuestion });
        }

        // 1a. Category fallback: deterministic match for ECM/DCM/munis/PE/etc.
        // expands to a small proxy entity set that goes through the same
        // resolve → ingest → retrieve pipeline.
        let category: DetectedCategory | null = null;
        if (result.resolved.length === 0) {
          category = detectCategory(query);
          if (category) {
            emit({ type: 'category_detected', category: category.category, label: category.label });
            for (const proxy of category.proxies) {
              const resolved = await resolveEntity(proxy.query);
              if (resolved && !result.resolved.some(r => r.id === resolved.id)) {
                result.resolved.push(resolved);
              }
            }
            emit({
              type: 'category_proxies',
              entities: result.resolved.map(e => ({ id: e.id, name: e.name, ticker: e.ticker })),
            });
          }
        }

        // 2. Ingest any unindexed entities (best-effort, time-budgeted)
        const ingestDeadline = Date.now() + INGEST_BUDGET_MS;
        for (const entity of result.resolved) {
          if (Date.now() > ingestDeadline) {
            emit({ type: 'ingest_skipped', entity: entity.name, reason: 'budget exceeded' });
            continue;
          }
          const snap = await getTargetSnapshot(entity.id);
          if (snap.exists && snap.status === 'indexed') {
            emit({ type: 'cache_hit', entity: entity.name, documents: snap.documents, chunks: snap.chunks });
            continue;
          }
          emit({ type: 'ingesting', entity: entity.name });
          await runIngestionWithDeadline(entity, ingestDeadline, emit);
        }

        // 3. Retrieval — vector search when we have a target, recency snapshot otherwise.
        const targetIds = result.resolved.map(e => e.id);
        const isBroad = targetIds.length === 0;
        emit({ type: 'retrieving', topK: TOP_K, mode: isBroad ? 'recent' : 'vector' });
        let chunks: RetrievedChunk[] = [];
        let indexedEntities: Array<{ id: string; name: string; ticker: string | null }> = [];
        try {
          if (isBroad) {
            // No entity resolved — broad question. Surface the most recent
            // corpus content + the list of indexed entities so the memo agent
            // can describe what's available.
            [chunks, indexedEntities] = await Promise.all([
              recentCorpusSnapshot({ limit: 12 }),
              listIndexedEntities(),
            ]);
          } else {
            chunks = await searchChunks(query, { topK: TOP_K, targetIds });
          }
        } catch (err) {
          emit({ type: 'retrieval_error', error: (err as Error).message });
        }
        emit({ type: 'retrieved', chunkCount: chunks.length });

        // 4. Build sources list and citation-numbered context
        const sources = chunks.map((c, idx) => ({
          n: idx + 1,
          title: c.documentTitle,
          url: c.documentUrl,
          source: c.documentSource,
          docType: c.documentType,
          filedAt: c.filedAt,
          isPrimary: c.isPrimarySource,
          targetId: c.targetId,
          similarity: Number(c.similarity.toFixed(3)),
        }));
        emit({ type: 'sources', sources });

        // 5. Synthesize answer (Sonnet stream)
        emit({ type: 'thinking' });
        const userMessage = buildUserPrompt(query, chunks, result.resolved, result.unresolved, indexedEntities, category);
        for await (const ev of streamSonnet({
          systemPrompt: MEMO_AGENT_PROMPT,
          userMessage,
          maxTokens: 1500,
        })) {
          if (ev.type === 'token') emit({ type: 'token', text: ev.text });
          else emit({ type: 'usage', input: ev.usage.input, output: ev.usage.output });
        }

        emit({ type: 'done', latencyMs: Date.now() - startedAt });
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

async function runIngestionWithDeadline(
  entity: ResolvedEntity,
  deadlineMs: number,
  emit: (e: object) => void,
): Promise<void> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 1500) {
    emit({ type: 'ingest_skipped', entity: entity.name, reason: 'budget exceeded' });
    return;
  }
  // Full mode so news + filing chunks land in pgvector and chat retrieval has
  // something to ground on. The pipeline caps total chunks at 20 to keep
  // Voyage usage in one batch (~10K tokens). Worst case adds ~22s when the
  // Voyage cross-call rate limit needs to be honored.
  let lastEvent: { type: string } | null = null;
  for await (const ev of ingestEntity(entity.name, { mode: 'full' })) {
    if (Date.now() > deadlineMs) {
      emit({ type: 'ingest_truncated', entity: entity.name });
      return;
    }
    lastEvent = ev;
    if (ev.type === 'fetched' || ev.type === 'done' || ev.type === 'error' || ev.type === 'unresolved') {
      emit({ type: 'ingest_progress', entity: entity.name, event: ev });
    }
  }
  emit({ type: 'ingest_complete', entity: entity.name, finalEventType: lastEvent?.type ?? 'unknown' });
}

function buildUserPrompt(
  query: string,
  chunks: RetrievedChunk[],
  resolved: ResolvedEntity[],
  unresolved: Array<{ name: string }>,
  indexedEntities: Array<{ id: string; name: string; ticker: string | null }>,
  category: DetectedCategory | null,
): string {
  const sourceBlocks = chunks.map((c, idx) => {
    const cite = idx + 1;
    const filed = c.filedAt ? new Date(c.filedAt).toISOString().slice(0, 10) : 'unknown date';
    const primaryTag = c.isPrimarySource ? '[primary]' : '[secondary]';
    return `[${cite}] ${primaryTag} ${c.documentTitle} — ${c.documentSource} ${c.documentType}, filed ${filed}\n${c.content.slice(0, 1200)}`;
  });

  const entitiesBlock = resolved.length > 0
    ? `Entities resolved: ${resolved.map(e => `${e.name}${e.ticker ? ` (${e.ticker})` : ''}`).join(', ')}`
    : 'No specific entity was extracted from this query.';
  const unresolvedBlock = unresolved.length > 0
    ? `Could not resolve: ${unresolved.map(e => e.name).join(', ')}`
    : '';

  const indexedBlock = indexedEntities.length > 0
    ? `Other indexed entities in the corpus (suggest as follow-ups): ${indexedEntities.map(e => `${e.name}${e.ticker ? ` (${e.ticker})` : ''}`).join(', ')}`
    : '';

  const sourcesText = sourceBlocks.length > 0
    ? `Retrieved sources (use [N] inline citations matching the bracketed number):\n\n${sourceBlocks.join('\n\n---\n\n')}`
    : 'No sources were retrieved from the corpus. Acknowledge the gap honestly. Suggest what data would need to be ingested.';

  let modeHint = '';
  if (category) {
    modeHint = `\n\nThis is a CATEGORY-LEVEL query about ${category.label} (${category.category}). The retrieved sources come from a small set of proxy issuers chosen as representatives of that category — they are NOT exhaustive. Synthesize what's happening across these proxies as a category-level view, attribute claims to the specific issuer/source, and end with a sentence inviting the user to drill into a specific name (e.g. "Want me to dig into JPMorgan's debt book specifically?").`;
  } else if (resolved.length === 0) {
    modeHint = `\n\nThis is a broad market query. The retrieved sources are the most-recent items across the entire indexed corpus. Describe what the corpus contains and point the user to specific entities they could ask about.`;
  }

  return `User query: ${query}\n\n${entitiesBlock}\n${unresolvedBlock}\n${indexedBlock}\n\n${sourcesText}${modeHint}`;
}
