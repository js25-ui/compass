import 'server-only';
import { getSupabaseService } from '@/lib/db/client';
import type { ResolvedEntity } from '@/lib/lookup/resolve';
import type { Json, TargetStatus } from '@/lib/db/types';
import type { PendingDocument } from './sources';
import type { SourceName } from './types';

export async function getTargetSnapshot(targetId: string): Promise<{
  exists: boolean;
  status: TargetStatus | null;
  documents: number;
  chunks: number;
}> {
  const sb = getSupabaseService();
  const target = await sb.from('targets').select('status').eq('id', targetId).maybeSingle();
  const targetData = target.data as { status: string | null } | null;
  if (!targetData) return { exists: false, status: null, documents: 0, chunks: 0 };

  const docs = await sb.from('documents').select('id', { count: 'exact', head: true }).eq('target_id', targetId);
  const docIds = await sb.from('documents').select('id').eq('target_id', targetId);
  const idRows = (docIds.data ?? []) as Array<{ id: string }>;
  const ids = idRows.map(r => r.id);
  let chunkCount = 0;
  if (ids.length > 0) {
    const c = await sb.from('chunks').select('id', { count: 'exact', head: true }).in('document_id', ids);
    chunkCount = c.count ?? 0;
  }
  return {
    exists: true,
    status: (targetData.status as TargetStatus | null) ?? null,
    documents: docs.count ?? 0,
    chunks: chunkCount,
  };
}

export async function upsertTarget(entity: ResolvedEntity, status: TargetStatus): Promise<void> {
  const sb = getSupabaseService();
  await sb
    .from('targets')
    .upsert(
      [
        {
          id: entity.id,
          name: entity.name,
          ticker: entity.ticker ?? null,
          cik: entity.cik ?? null,
          business_line: entity.business_line_guess ?? null,
          entity_type: entity.entity_type,
          status,
          last_queried_at: new Date().toISOString(),
          metadata: {
            resolution_source: entity.source,
            confidence: entity.confidence,
          } satisfies Json,
          updated_at: new Date().toISOString(),
        },
      ],
      { onConflict: 'id' },
    );
}

export async function bumpLastQueried(targetId: string): Promise<void> {
  const sb = getSupabaseService();
  await sb.from('targets').update({ last_queried_at: new Date().toISOString() }).eq('id', targetId);
}

export async function upsertDocuments(targetId: string, docs: PendingDocument[]): Promise<void> {
  if (docs.length === 0) return;
  const sb = getSupabaseService();
  const rows = docs.map(d => ({
    id: d.id,
    target_id: targetId,
    source: d.source,
    doc_type: d.doc_type,
    title: d.title,
    url: d.url,
    content_full: d.content_full,
    filed_at: d.filed_at,
    metadata: d.metadata,
    is_primary_source: d.is_primary_source,
    retrieved_at: new Date().toISOString(),
  }));
  // Postgres caps a single round-trip; chunk to be safe.
  for (let i = 0; i < rows.length; i += 100) {
    const slice = rows.slice(i, i + 100);
    const { error } = await sb.from('documents').upsert(slice, { onConflict: 'id' });
    if (error) throw new Error(`upsertDocuments: ${error.message}`);
  }
}

export interface PendingChunk {
  documentId: string;
  index: number;
  content: string;
  embedding: number[];
}

/** Replace any existing chunks for the given document IDs, then insert the new ones. */
export async function replaceChunks(documentIds: string[], chunks: PendingChunk[]): Promise<void> {
  const sb = getSupabaseService();
  if (documentIds.length > 0) {
    const { error } = await sb.from('chunks').delete().in('document_id', documentIds);
    if (error) throw new Error(`replaceChunks delete: ${error.message}`);
  }
  if (chunks.length === 0) return;

  const rows = chunks.map(c => ({
    document_id: c.documentId,
    chunk_index: c.index,
    content: c.content,
    embedding: c.embedding,
  }));
  for (let i = 0; i < rows.length; i += 100) {
    const slice = rows.slice(i, i + 100);
    const { error } = await sb.from('chunks').insert(slice);
    if (error) throw new Error(`replaceChunks insert: ${error.message}`);
  }
}

export async function recordIngestRun(input: {
  targetId: string;
  source: SourceName;
  status: 'success' | 'partial' | 'error';
  documentsAdded: number;
  chunksAdded: number;
  durationMs: number;
  error?: string | null;
}): Promise<void> {
  const sb = getSupabaseService();
  await sb.from('ingest_runs').insert([
    {
      target_id: input.targetId,
      source: input.source,
      status: input.status,
      documents_added: input.documentsAdded,
      chunks_added: input.chunksAdded,
      error: input.error ?? null,
      duration_ms: input.durationMs,
    },
  ]);
}
