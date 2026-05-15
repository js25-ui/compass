/**
 * Tool-using chat agent.
 *
 * Sonnet drives the entire conversation. It has full domain knowledge of
 * capital-markets terminology (ECM, DCM, munis, PE, etc.) and decides on
 * its own which tools to call to answer the user's question. No hardcoded
 * category tables, no static proxy lists — the model picks what to research.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropic, SONNET_MODEL } from '@/lib/llm/anthropic';
import { ingestEntity } from '@/lib/ingest/pipeline';
import { resolveEntity, type ResolvedEntity } from '@/lib/lookup/resolve';
import { getTargetSnapshot } from '@/lib/ingest/persist';
import {
  listIndexedEntities,
  recentCorpusSnapshot,
  searchChunks,
  type RetrievedChunk,
} from '@/lib/retrieval/vector_search';
import { detectFactsLookup } from '@/lib/retrieval/query_intent';
import { lookupXbrlFacts, summarizeFactsForPrompt } from '@/lib/retrieval/xbrl_lookup';

const MAX_TURNS = 3;
const INGEST_BUDGET_MS = 25_000;

const SYSTEM_PROMPT = `You are Compass, a capital-markets analyst assistant. You help users research companies, deals, securities, and market activity.

Voice: a professional analyst on a desk — direct, substantive, no filler. Conversational but serious. Don't over-explain terminology unless context suggests the user needs it.

You have full domain knowledge of capital markets:
- ECM (equity capital markets): IPOs, follow-ons, secondaries, SPACs, equity issuance
- DCM (debt capital markets): IG and HY corporate bonds, new-issue activity, credit spreads, indentures
- Munis: GO bonds, revenue bonds, state/city issuance, tax-exempt
- Sovereigns: Treasuries, gilts, EM debt
- Alternatives: PE, LBOs, hedge funds, private credit, infrastructure, real estate, BDCs
- Macro: Fed policy, FOMC, OAS, IG and HY spreads, Treasury curve, FX
- Workflows: pricing, allocation, syndication, risk, sourcing, comp screens

Tools available:
- search_corpus: vector search over the indexed corpus (SEC filings + news + macro)
- list_indexed_entities: see what's already in the corpus
- list_recent_corpus: see the latest documents added across all entities
- ingest_entity: pull SEC filings + news for an entity (10-25 seconds; use sparingly)

DELIVERABLE PIPELINES — separate from this agent:
- Compass HAS shipped deliverable pipelines for LBO, trading comps, IPO valuation, bond pricing, IC memo, pitch book, and precedent transactions. They are routed BEFORE this chat agent based on task_type from the clarification step. You don't have tool access to them — they fire as a separate code path.
- If the user asks Compass to build a model or generate a deliverable IN THIS CHAT (i.e. it reached you instead of being routed), it usually means the routing didn't classify their request as a deliverable. Tell the user the deliverable pipeline exists and ask them to re-submit via the scope card (e.g. "Build LBO model on [target] at $X EV" or click the deliverable buttons in the workstation). Don't pretend the model can't be built.
- Your job here is conversational answers grounded in the corpus — context, news, filings, sector reads. The deliverable pipelines handle structured outputs.

How to think — TIGHT BUDGET (3 tool turns max):

1. ALWAYS use tools to ground your answer. Don't answer from memory alone — call search_corpus first to see what the corpus actually contains. But COMMIT TO AN ANSWER FAST: total tool calls across the conversation must stay under 4. After each tool result, ask yourself: "Do I have enough to write a useful sourced answer?" If yes, stop calling tools and write.

2. If the query is about a specific company/security/topic: ONE search_corpus call. If retrieval is empty AND the entity is identifiable, ONE ingest_entity call, then ONE final search_corpus call. Then answer. That's the budget.

3. If the query is broad ("what's new in ECM", "muni activity"): interpret it directly (ECM = equity capital markets — IPOs, follow-ons, secondaries). Call list_recent_corpus once OR search_corpus once with the right terms. Then answer.

4. If the query is genuinely ambiguous ("compare to comps" with no anchor; "the deal" with no antecedent): ask ONE specific clarifying question. Don't bounce the user when the question is broad-but-answerable.

5. After your tool calls — and AT MOST after 2-3 tool calls regardless of what you've found — write the final answer. Better to answer with partial data and flag the gap than keep researching forever.

Citation rules — strictly enforced:
- Every search_corpus result includes a stable citation number "n" — use those in your answer as <a class="chat-citation" href="#source-N">N</a>.
- Distinguish primary (SEC filings) from secondary (news) when relevant.
- Every numerical value should include "as of [date]" using the source's filed_at.
- If retrieval is empty, say so explicitly. Never fabricate filings, prices, deal terms, or quotes.
- If the user asks about a date range you can't cover, name the gap.

Output format:
- Plain HTML for the final answer: <p>, <strong>, <ul>, <a class="chat-citation" href="#source-N">N</a>.
- Lead with the direct answer, then evidence, then caveats.
- Keep it tight: 3-5 paragraphs unless the user explicitly asks for depth.
- Don't output a sources list — the UI renders it separately.`;

interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'search_corpus',
    description: 'Vector-similarity search over indexed text chunks. Returns the top matching chunks with their source documents.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query, e.g. "Boeing debt profile" or "recent IPO activity in tech"' },
        target_ids: { type: 'array', items: { type: 'string' }, description: 'Optional: filter to specific entity IDs (from list_indexed_entities)' },
        top_k: { type: 'number', description: 'Number of chunks to return (default 8, max 12)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_indexed_entities',
    description: 'List entities currently indexed in the corpus, ordered by most recently queried.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_recent_corpus',
    description: 'List the most recent documents added across all indexed entities. Useful for "what is new" style queries.',
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', description: 'Lookback window in days (default 30, max 90)' },
        limit: { type: 'number', description: 'Max documents to return (default 12)' },
      },
    },
  },
  {
    name: 'ingest_entity',
    description: 'Pull recent SEC filings, XBRL facts, news, and GDELT articles for an entity into the corpus. Takes 10-25 seconds. Use only when the corpus genuinely lacks coverage for the entity the user asked about.',
    input_schema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Company name, ticker, or curated entity (e.g. "Apple", "AAPL", "New York City")' },
      },
      required: ['entity'],
    },
  },
];

export interface AgentSourceCitation {
  n: number;
  title: string;
  url: string | null;
  source: string;
  docType: string;
  filedAt: string | null;
  isPrimary: boolean;
  similarity: number;
  targetId: string | null;
}

export type AgentEvent =
  | { type: 'thinking' }
  | { type: 'tool_call'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; summary: string }
  | { type: 'sources'; sources: AgentSourceCitation[] }
  | { type: 'token'; text: string }
  | { type: 'usage'; input: number; output: number }
  | { type: 'done'; latencyMs: number; turns: number }
  | { type: 'error'; error: string };

interface AgentState {
  citationCounter: number;
  citations: AgentSourceCitation[];
  ingestStartedAt: number;
}

export interface ChatAgentHistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatAgentOptions {
  /** Recent turns from this conversation. Threaded as messages so Sonnet
   *  has continuity ("the data" = Cava if Cava was just discussed). */
  history?: ChatAgentHistoryTurn[];
  /** Most-recent established context — entity + task — that the prior
   *  conversation was about. Surfaced as a system note so the agent
   *  doesn't ask "which entity?" when it's already obvious. */
  priorContext?: {
    detectedTarget: { name: string; ticker?: string } | null;
    taskType: string;
  } | null;
  /** Target the classifier identified for THIS turn. When set, the agent
   *  resolves it, checks whether the corpus has any documents for that
   *  target_id, and pre-emptively ingests if not — so the first
   *  search_corpus call against this entity returns real chunks instead
   *  of unfiltered vector-similar near-misses (Carvana → CAVA Group). */
  currentTarget?: { name: string; ticker?: string } | null;
}

export async function* runChatAgent(query: string, opts: ChatAgentOptions = {}): AsyncGenerator<AgentEvent> {
  const startedAt = Date.now();
  const client = getAnthropic();
  const state: AgentState = {
    citationCounter: 0,
    citations: [],
    ingestStartedAt: 0,
  };

  // ---------- Entity-aware pre-ingest ----------
  // When the classifier identified an entity for this turn, resolve it
  // and check whether the corpus already has documents for that target_id.
  // If not, ingest BEFORE Sonnet starts — otherwise the first
  // search_corpus call returns vector-similar near-misses for a
  // completely different entity (the Carvana → CAVA Group bug), Sonnet
  // never reaches its "empty → ingest" rule, and the answer is "we
  // don't have it" when we should have just gotten it.
  let pinnedTarget: ResolvedEntity | null = null;
  if (opts.currentTarget?.name) {
    try {
      pinnedTarget = await resolveEntity(opts.currentTarget.ticker ?? opts.currentTarget.name);
    } catch {
      pinnedTarget = null;
    }
  }
  if (pinnedTarget) {
    let docsForTarget = 0;
    try {
      const snap = await getTargetSnapshot(pinnedTarget.id);
      docsForTarget = snap.documents;
    } catch {
      // Supabase unreachable — let Sonnet flow handle it; it'll explain.
      docsForTarget = -1;
    }
    if (docsForTarget === 0) {
      yield {
        type: 'tool_call',
        name: 'ingest_entity',
        input: { entity: pinnedTarget.name, reason: 'corpus has 0 docs for this target' },
      };
      state.ingestStartedAt = Date.now();
      const deadline = state.ingestStartedAt + INGEST_BUDGET_MS;
      let ingestedDocs = 0;
      let ingestedChunks = 0;
      let ingestError: string | null = null;
      try {
        for await (const ev of ingestEntity(pinnedTarget.name, { mode: 'full' })) {
          if (Date.now() > deadline) {
            ingestError = `ingest exceeded ${INGEST_BUDGET_MS / 1000}s budget; stopped early`;
            break;
          }
          if (ev.type === 'done') {
            ingestedDocs = ev.documentsAdded;
            ingestedChunks = ev.chunksAdded;
          } else if (ev.type === 'cached') {
            ingestedDocs = ev.documents;
            ingestedChunks = ev.chunks;
          } else if (ev.type === 'error') {
            ingestError = ev.error;
          }
        }
      } catch (err) {
        ingestError = err instanceof Error ? err.message : 'ingest threw';
      }
      yield {
        type: 'tool_result',
        name: 'ingest_entity',
        summary: ingestError
          ? `ingest ${pinnedTarget.name} failed: ${ingestError}`
          : `${pinnedTarget.name}: ${ingestedDocs} docs, ${ingestedChunks} chunks indexed`,
      };
    }
  }

  // ---------- XBRL fact pre-fetch ----------
  // If the user is asking about specific financial metrics for a pinned
  // target with a CIK, hit financial_facts directly before Sonnet starts.
  // The chunk re-ranker biases retrieval toward the income statement /
  // MD&A, but XBRL values are canonically structured and don't depend on
  // the model finding the right table — surface them in the system prompt
  // so Sonnet can cite specific numbers even if a vector chunk for that
  // exact metric never surfaces.
  let xbrlSummary = '';
  if (pinnedTarget?.cik) {
    const requestedMetrics = detectFactsLookup(query);
    if (requestedMetrics.length > 0) {
      try {
        const xbrl = await lookupXbrlFacts({
          targetId: pinnedTarget.id,
          metrics: requestedMetrics,
          periodsBack: 3,
        });
        if (xbrl.values.length > 0) {
          xbrlSummary = summarizeFactsForPrompt(pinnedTarget.name, xbrl);
          yield {
            type: 'tool_result',
            name: 'lookup_facts',
            summary: `XBRL facts pre-fetched for ${pinnedTarget.name}: ${xbrl.values.map(v => v.metric).join(', ')} (${xbrl.values.length}/${requestedMetrics.length} metrics)`,
          };
        }
      } catch {
        // Soft-fail — Sonnet still has the chunk-retrieval path.
      }
    }
  }

  // Build messages with history. Strip prior assistant HTML to plain text;
  // skip empty entries.
  const historyMessages: Anthropic.Messages.MessageParam[] = (opts.history ?? [])
    .filter(t => t.text && t.text.trim().length > 0)
    .map(t => ({ role: t.role, content: t.text }));

  const messages: Anthropic.Messages.MessageParam[] = [
    ...historyMessages,
    { role: 'user', content: query },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    yield { type: 'thinking' };

    // The LAST turn forces a final answer. Two concrete things must happen:
    //   1. Inject a synthetic "now write the answer" user message — without
    //      it, Sonnet sees the prior tool_result as a dead-end conversation
    //      and emits a stop with empty content.
    //   2. tool_choice='none' tells Sonnet not to request more tools.
    // We keep `tools` in the request because prior assistant messages
    // contain tool_use blocks; dropping `tools` makes the request invalid.
    const isLastTurn = turn === MAX_TURNS - 1;
    const priorContextNote = opts.priorContext?.detectedTarget?.name
      ? `\n\nPRIOR CONVERSATION CONTEXT: This conversation has been about ${opts.priorContext.detectedTarget.name}${opts.priorContext.detectedTarget.ticker ? ` (${opts.priorContext.detectedTarget.ticker})` : ''}, task=${opts.priorContext.taskType}. When the user's current message is ambiguous about the target ("the data", "their financials", "is there 2025 data"), assume they mean ${opts.priorContext.detectedTarget.name} unless they explicitly name a different entity.`
      : '';
    const pinnedTargetNote = pinnedTarget
      ? `\n\nPINNED TARGET FOR THIS TURN: The user's named entity is ${pinnedTarget.name}${pinnedTarget.ticker ? ` (${pinnedTarget.ticker})` : ''}, target_id="${pinnedTarget.id}". The on-demand ingest already ran for this entity — the corpus has its filings + news indexed under this target_id. Required tool flow:
  1. Make EXACTLY ONE search_corpus call with target_ids=["${pinnedTarget.id}"] using natural-language keywords for what the user asked.
  2. Then immediately WRITE THE FINAL ANSWER in your next turn.
Do NOT call search_corpus a second time on the same target — the first targeted search returns everything we have indexed, additional searches won't surface new content and will use up the function-timeout budget. Do NOT call ingest_entity for this target again; it's already been ingested for this turn.`
      : '';
    const xbrlNote = xbrlSummary
      ? `\n\n${xbrlSummary}\n\nThese XBRL values come straight from SEC EDGAR companyfacts — they're more authoritative than any chunk excerpt for quantitative metrics. Cite them in your answer as 'per SEC XBRL company facts' when the user is asking about specific numbers. Vector chunks may still be useful for color (MD&A commentary, segment breakdowns), but treat the XBRL values as the source of truth for any metric named above.`
      : '';
    const turnSystem = isLastTurn
      ? `${SYSTEM_PROMPT}${priorContextNote}${pinnedTargetNote}${xbrlNote}\n\nFINAL TURN: tool budget exhausted. Write the final answer in HTML now using only the tool results already in this conversation.`
      : `${SYSTEM_PROMPT}${priorContextNote}${pinnedTargetNote}${xbrlNote}`;

    const turnMessages: Anthropic.Messages.MessageParam[] = isLastTurn
      ? [
          ...messages,
          {
            role: 'user',
            content: 'Now write the final answer to my original question using the data you already retrieved. If the question asked for a model, deliverable, or capability Compass does not have, acknowledge that in the first sentence and provide the best sourced narrative you can. Use [N] inline citations matching the chunk numbers from your search results. Output HTML (paragraphs, <strong>, <a class="chat-citation" href="#source-N">N</a>). Do not call any more tools.',
          },
        ]
      : messages;

    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model: SONNET_MODEL,
        max_tokens: 2000,
        system: [{ type: 'text', text: turnSystem, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS as unknown as Anthropic.Messages.Tool[],
        ...(isLastTurn ? { tool_choice: { type: 'none' as const } } : {}),
        messages: turnMessages,
      });
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err.message : 'Sonnet call failed' };
      return;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
    );
    const textBlocks = response.content.filter(
      (b): b is Anthropic.Messages.TextBlock => b.type === 'text',
    );

    if (toolUses.length === 0) {
      // Final answer turn
      if (state.citations.length > 0) {
        yield { type: 'sources', sources: state.citations };
      }
      const finalText = textBlocks.map(b => b.text).join('').trim();
      if (finalText) {
        yield { type: 'token', text: finalText };
      } else {
        yield {
          type: 'error',
          error: `Sonnet returned no text on the final turn (stop_reason=${response.stop_reason ?? 'unknown'}, output_tokens=${response.usage.output_tokens}). The agent may have run out of useful tool calls. Try rephrasing the query.`,
        };
      }
      yield {
        type: 'usage',
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      };
      yield { type: 'done', latencyMs: Date.now() - startedAt, turns: turn + 1 };
      return;
    }

    // Run tools
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      yield { type: 'tool_call', name: toolUse.name, input: toolUse.input as Record<string, unknown> };
      const result = await executeTool(toolUse.name, toolUse.input as Record<string, unknown>, state);
      yield { type: 'tool_result', name: toolUse.name, summary: result.summary };
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.content,
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }

  yield { type: 'error', error: 'Agent exceeded maximum tool-use turns' };
}

interface ToolResult {
  summary: string;
  content: string;
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  state: AgentState,
): Promise<ToolResult> {
  try {
    if (name === 'search_corpus') {
      const query = String(input.query ?? '');
      const topK = Math.min(Number(input.top_k ?? 8), 12);
      const targetIds = Array.isArray(input.target_ids) ? (input.target_ids as string[]) : undefined;
      const chunks = await searchChunks(query, { topK, targetIds });
      return formatSearchResult(chunks, state, `search_corpus("${query.slice(0, 60)}")`);
    }

    if (name === 'list_indexed_entities') {
      const entities = await listIndexedEntities();
      const summary = entities.length === 0
        ? 'corpus is empty'
        : `${entities.length} indexed entities`;
      const content = JSON.stringify(
        entities.map(e => ({ id: e.id, name: e.name, ticker: e.ticker })),
      );
      return { summary, content };
    }

    if (name === 'list_recent_corpus') {
      const daysBack = Math.min(Number(input.days_back ?? 30), 90);
      const limit = Math.min(Number(input.limit ?? 12), 25);
      const chunks = await recentCorpusSnapshot({ daysBack, limit });
      return formatSearchResult(chunks, state, `list_recent_corpus(${daysBack}d)`);
    }

    if (name === 'ingest_entity') {
      const entity = String(input.entity ?? '').trim();
      if (!entity) return { summary: 'no entity given', content: 'error: entity is required' };
      if (state.ingestStartedAt > 0) {
        return { summary: 'ingest budget already used', content: 'error: only one ingest_entity call allowed per query' };
      }
      state.ingestStartedAt = Date.now();
      let docs = 0;
      let chunks = 0;
      let targetId: string | null = null;
      let unresolved = false;
      const deadline = state.ingestStartedAt + INGEST_BUDGET_MS;
      for await (const ev of ingestEntity(entity, { mode: 'full' })) {
        if (Date.now() > deadline) break;
        if (ev.type === 'done') {
          docs = ev.documentsAdded;
          chunks = ev.chunksAdded;
          targetId = ev.targetId;
        } else if (ev.type === 'cached') {
          docs = ev.documents;
          chunks = ev.chunks;
          targetId = ev.targetId;
        } else if (ev.type === 'unresolved') {
          unresolved = true;
        }
      }
      if (unresolved) {
        return {
          summary: `couldn't resolve "${entity}"`,
          content: JSON.stringify({ resolved: false }),
        };
      }
      return {
        summary: `${entity}: ${docs} docs, ${chunks} chunks indexed`,
        content: JSON.stringify({ resolved: true, target_id: targetId, documents: docs, chunks }),
      };
    }

    return { summary: 'unknown tool', content: `error: unknown tool ${name}` };
  } catch (err) {
    return {
      summary: `${name} failed`,
      content: `error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function formatSearchResult(chunks: RetrievedChunk[], state: AgentState, label: string): ToolResult {
  if (chunks.length === 0) {
    return { summary: `${label}: no matches`, content: '[]' };
  }

  const numbered = chunks.map(chunk => {
    state.citationCounter += 1;
    const n = state.citationCounter;
    state.citations.push({
      n,
      title: chunk.documentTitle,
      url: chunk.documentUrl,
      source: chunk.documentSource,
      docType: chunk.documentType,
      filedAt: chunk.filedAt,
      isPrimary: chunk.isPrimarySource,
      similarity: Number(chunk.similarity.toFixed(3)),
      targetId: chunk.targetId,
    });
    return {
      n,
      title: chunk.documentTitle,
      source: chunk.documentSource,
      doc_type: chunk.documentType,
      filed_at: chunk.filedAt,
      is_primary: chunk.isPrimarySource,
      url: chunk.documentUrl,
      excerpt: chunk.content.slice(0, 800),
    };
  });

  const counts: Record<string, number> = {};
  for (const c of chunks) {
    const key = c.documentSource;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const summary = `${label}: ${chunks.length} chunks (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')})`;
  return { summary, content: JSON.stringify(numbered) };
}
