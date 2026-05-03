import { NextRequest } from 'next/server';
import { recentCorpusSnapshot } from '@/lib/retrieval/vector_search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface NewsItem {
  documentId: string;
  targetId: string | null;
  title: string;
  url: string | null;
  source: string;
  docType: string;
  filedAt: string | null;
  isPrimary: boolean;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 12), 30);
  const daysBack = Math.min(Number(url.searchParams.get('days_back') ?? 14), 60);

  try {
    const chunks = await recentCorpusSnapshot({ limit, daysBack });
    // Dedup by documentId — recentCorpusSnapshot returns at most one chunk per doc but be safe.
    const seen = new Set<string>();
    const items: NewsItem[] = [];
    for (const c of chunks) {
      if (seen.has(c.documentId)) continue;
      seen.add(c.documentId);
      items.push({
        documentId: c.documentId,
        targetId: c.targetId,
        title: c.documentTitle,
        url: c.documentUrl,
        source: c.documentSource,
        docType: c.documentType,
        filedAt: c.filedAt,
        isPrimary: c.isPrimarySource,
      });
    }
    return Response.json({ items });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'recent-news failed', items: [] }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
