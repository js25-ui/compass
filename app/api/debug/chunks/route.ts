/**
 * Temporary diagnostic — list documents + chunk counts by section for a
 * given target_id. Used to confirm whether 10-Q income-statement chunks
 * are actually in the corpus. Remove once retrieval-quality work lands.
 */

import { NextRequest } from 'next/server';
import { getSupabaseService } from '@/lib/db/client';
import { searchChunks } from '@/lib/retrieval/vector_search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const targetId = url.searchParams.get('target_id');
  const query = url.searchParams.get('q');
  if (!targetId) {
    return Response.json({ error: 'target_id is required' }, { status: 400 });
  }

  try {
    const sb = getSupabaseService();

    // Documents for this target
    const docsRes = await sb
      .from('documents')
      .select('id, doc_type, title, filed_at, source')
      .eq('target_id', targetId)
      .order('filed_at', { ascending: false })
      .limit(50);
    type DocRow = { id: string; doc_type: string; title: string; filed_at: string | null; source: string };
    const docs = (docsRes.data ?? []) as DocRow[];

    // Chunks for each doc — count + section breakdown + indices
    type DocSummary = {
      id: string;
      doc_type: string;
      title: string;
      filed_at: string | null;
      source: string;
      chunkCount: number;
      contentLen: number | null;
      sections: Record<string, number>;
      indices: number[];
      previews: Array<{ idx: number; section: string | null; preview: string }>;
    };
    const docSummaries: DocSummary[] = [];
    for (const doc of docs) {
      const chunksRes = await sb
        .from('chunks')
        .select('chunk_index, section, content')
        .eq('document_id', doc.id)
        .order('chunk_index');
      type ChunkRow = { chunk_index: number; section: string | null; content: string };
      const chunks = (chunksRes.data ?? []) as ChunkRow[];
      const sections: Record<string, number> = {};
      for (const c of chunks) {
        const s = c.section ?? 'no-tag';
        sections[s] = (sections[s] ?? 0) + 1;
      }
      // Fetch the document's content_full length (don't return the body — too big)
      const docRes = await sb.from('documents').select('content_full').eq('id', doc.id).maybeSingle();
      type ContentRow = { content_full: string | null };
      const contentLen = (docRes.data as ContentRow | null)?.content_full?.length ?? null;

      docSummaries.push({
        id: doc.id,
        doc_type: doc.doc_type,
        title: doc.title,
        filed_at: doc.filed_at,
        source: doc.source,
        chunkCount: chunks.length,
        contentLen,
        sections,
        indices: chunks.map(c => c.chunk_index),
        previews: chunks.slice(0, 3).map(c => ({
          idx: c.chunk_index,
          section: c.section,
          preview: c.content.slice(0, 200),
        })),
      });
    }

    let searchPreview: unknown = null;
    if (query) {
      const results = await searchChunks(query, {
        topK: 30,
        targetIds: [targetId],
      });
      searchPreview = results.map(r => ({
        chunkId: r.chunkId,
        documentId: r.documentId,
        docType: r.documentType,
        title: r.documentTitle.slice(0, 60),
        section: r.section,
        similarity: r.similarity,
        rerankScore: r.rerankScore,
        contentPreview: r.content.slice(0, 200),
      }));
    }

    return Response.json({
      targetId,
      query,
      docCount: docs.length,
      docs: docSummaries,
      searchPreview,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
