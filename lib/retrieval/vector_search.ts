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
