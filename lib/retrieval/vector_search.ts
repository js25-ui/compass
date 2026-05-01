import { getSupabaseService } from '@/lib/db/client';
import { embedTexts } from '@/lib/embeddings/voyage';

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  targetId: string | null;
  content: string;
  similarity: number;
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
  const { data, error } = await sb.rpc('match_chunks', {
    query_embedding: embedding,
    match_count: topK,
    filter_target_ids: opts.targetIds ?? null,
  });
  if (error) throw new Error(`match_chunks RPC failed: ${error.message}`);

  return (data as RpcRow[])
    .filter(r => r.similarity >= minSim)
    .map(r => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      targetId: r.target_id,
      content: r.content,
      similarity: r.similarity,
      documentTitle: r.document_title,
      documentUrl: r.document_url,
      documentSource: r.document_source,
      documentType: r.document_doc_type,
      filedAt: r.document_filed_at,
      isPrimarySource: r.is_primary_source,
    }));
}
