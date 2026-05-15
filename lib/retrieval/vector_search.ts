import { getSupabaseService } from '@/lib/db/client';
import { embedTexts } from '@/lib/embeddings/voyage';
import { classifyQueryIntent, type QueryIntent } from './query_intent';
import {
  SECTION_WEIGHTS,
  detectSectionFromChunkContent,
  type SectionTag,
} from './sections';

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  targetId: string | null;
  content: string;
  /** Cosine similarity from the vector RPC (0–1). */
  similarity: number;
  /** similarity × section weight for the detected query intent.
   *  Used to re-order the result set; preserved for the Work tab to show
   *  why a chunk ranked where it did. */
  rerankScore?: number;
  section?: SectionTag;
  queryIntent?: QueryIntent;
  documentTitle: string;
  documentUrl: string | null;
  documentSource: string;
  documentType: string;
  filedAt: string | null;
  isPrimarySource: boolean;
}

interface RpcRow {
  chunk_id: string;
  document_id: string;
  target_id: string | null;
  content: string;
  similarity: number;
  document_title: string;
  document_url: string | null;
  document_source: string;
  document_doc_type: string;
  document_filed_at: string | null;
  is_primary_source: boolean;
}

export interface SearchOptions {
  topK?: number;
  targetIds?: string[];
  minSimilarity?: number;
  /** Override the auto-classified intent (rare — useful when the caller
   *  knows the query better than the keyword classifier, e.g. a fixed
   *  pipeline always wanting income_statement-weighted results). */
  intentOverride?: QueryIntent;
  /** Skip the section-aware re-rank and return raw cosine ordering.
   *  Useful for cases where re-ranking shouldn't apply (corpus-wide
   *  "what's new" sweeps over news). Default false. */
  disableRerank?: boolean;
}

/**
 * Fallback retrieval for queries with no resolvable entity. Returns the most
 * recently filed documents across the corpus (one synthetic chunk each, drawn
 * from title + content) ordered by filed_at desc. Lets the memo agent at
 * least describe what the corpus contains rather than going blank.
 */
export async function recentCorpusSnapshot(opts: { limit?: number; daysBack?: number } = {}): Promise<RetrievedChunk[]> {
  const limit = opts.limit ?? 12;
  const daysBack = opts.daysBack ?? 60;
  const cutoff = new Date(Date.now() - daysBack * 86_400_000).toISOString();

  const sb = getSupabaseService();
  const { data, error } = await sb
    .from('documents')
    .select('id, target_id, source, doc_type, title, url, filed_at, is_primary_source, content_full')
    .gte('filed_at', cutoff)
    .order('filed_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`recent corpus query failed: ${error.message}`);

  type DocRow = {
    id: string; target_id: string | null; source: string; doc_type: string;
    title: string; url: string | null; filed_at: string | null;
    is_primary_source: boolean; content_full: string | null;
  };
  const rows = (data ?? []) as DocRow[];
  return rows.map((r, idx) => ({
    chunkId: `synthetic-${idx}`,
    documentId: r.id,
    targetId: r.target_id,
    content: (r.content_full ?? r.title).slice(0, 800),
    similarity: 1 - idx / rows.length,            // monotonic placeholder
    documentTitle: r.title,
    documentUrl: r.url,
    documentSource: r.source,
    documentType: r.doc_type,
    filedAt: r.filed_at,
    isPrimarySource: r.is_primary_source,
  }));
}

export async function listIndexedEntities(): Promise<Array<{ id: string; name: string; ticker: string | null }>> {
  const sb = getSupabaseService();
  const { data } = await sb
    .from('targets')
    .select('id, name, ticker')
    .eq('status', 'indexed')
    .order('last_queried_at', { ascending: false, nullsFirst: false })
    .limit(20);
  return (data ?? []) as Array<{ id: string; name: string; ticker: string | null }>;
}

export async function searchChunks(query: string, opts: SearchOptions = {}): Promise<RetrievedChunk[]> {
  const topK = opts.topK ?? 8;
  const minSim = opts.minSimilarity ?? 0.0;

  const [embedding] = await embedTexts([query], 'query');
  if (!embedding) return [];

  const sb = getSupabaseService();
  // Fetch ~3x the requested topK so the section-aware re-ranker has room
  // to surface income-statement / MD&A chunks that the raw cosine ranking
  // buried under forward-looking-statement boilerplate.
  const overFetch = opts.disableRerank ? topK : Math.min(topK * 3, 36);
  const { data, error } = await sb.rpc('match_chunks', {
    query_embedding: embedding,
    match_count: overFetch,
    filter_target_ids: opts.targetIds ?? null,
  });
  if (error) throw new Error(`match_chunks RPC failed: ${error.message}`);

  const rows = (data as RpcRow[]).filter(r => r.similarity >= minSim);
  if (rows.length === 0) return [];

  // Look up section tags. The match_chunks RPC pre-dates section tagging
  // and doesn't return chunks.section, so a follow-up SELECT covers it.
  // Legacy chunks (ingested before section tagging) have section=NULL —
  // for those we infer from the chunk content as a fallback.
  const chunkIds = rows.map(r => r.chunk_id);
  let sectionByChunkId = new Map<string, string | null>();
  try {
    const { data: secRows } = await sb
      .from('chunks')
      .select('id, section')
      .in('id', chunkIds);
    type SecRow = { id: string; section: string | null };
    for (const sr of (secRows ?? []) as SecRow[]) {
      sectionByChunkId.set(sr.id, sr.section);
    }
  } catch {
    // If the section SELECT fails, fall back to content-based detection
    // below — never block retrieval on the section lookup.
    sectionByChunkId = new Map();
  }

  // Classify the query once for the whole batch.
  const intent = opts.intentOverride ?? classifyQueryIntent(query).intent;

  const enriched: RetrievedChunk[] = rows.map(r => {
    const storedSection = sectionByChunkId.get(r.chunk_id) ?? null;
    const section: SectionTag = (storedSection as SectionTag | null)
      ?? detectSectionFromChunkContent(r.content);
    const weight = SECTION_WEIGHTS[section][intent] ?? 1.0;
    return {
      chunkId: r.chunk_id,
      documentId: r.document_id,
      targetId: r.target_id,
      content: r.content,
      similarity: r.similarity,
      rerankScore: r.similarity * weight,
      section,
      queryIntent: intent,
      documentTitle: r.document_title,
      documentUrl: r.document_url,
      documentSource: r.document_source,
      documentType: r.document_doc_type,
      filedAt: r.document_filed_at,
      isPrimarySource: r.is_primary_source,
    };
  });

  if (opts.disableRerank) {
    return enriched.slice(0, topK);
  }

  enriched.sort((a, b) => (b.rerankScore ?? b.similarity) - (a.rerankScore ?? a.similarity));
  return enriched.slice(0, topK);
}
