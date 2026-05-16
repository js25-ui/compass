import { NextRequest } from 'next/server';
import { getSupabaseService } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LibraryItem {
  documentId: string;
  targetId: string | null;
  title: string;
  url: string | null;
  source: string;
  docType: string;
  filedAt: string | null;
  /** When the filed_at came from a canonical meta-tag fetch instead of the
   *  feed's pubDate, this is set. Lets the Work tab show provenance. */
  feedReportedDate?: string | null;
  canonicalDate?: string | null;
  isPrimary: boolean;
}

interface SourceStat {
  source: string;
  count: number;
  lastFiledAt: string | null;
}

interface LibraryResponse {
  items: LibraryItem[];
  total: number;
  sourceStats: SourceStat[];
  refreshedAt: string;
  windowDays: number;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 500);
  const daysBack = Math.min(Number(url.searchParams.get('days_back') ?? 30), 365);
  const cutoff = new Date(Date.now() - daysBack * 86_400_000).toISOString();

  try {
    const sb = getSupabaseService();

    // Items in window, newest first.
    const { data: itemRows, error: itemErr } = await sb
      .from('documents')
      .select('id, target_id, source, doc_type, title, url, filed_at, is_primary_source, metadata')
      .gte('filed_at', cutoff)
      .order('filed_at', { ascending: false })
      .limit(limit);
    if (itemErr) throw new Error(`library items query failed: ${itemErr.message}`);

    type DocRow = {
      id: string; target_id: string | null; source: string; doc_type: string;
      title: string; url: string | null; filed_at: string | null; is_primary_source: boolean;
      metadata: Record<string, unknown> | null;
    };
    const items: LibraryItem[] = (itemRows ?? []).map((r: DocRow) => {
      const meta = r.metadata ?? {};
      return {
        documentId: r.id,
        targetId: r.target_id,
        title: r.title,
        url: r.url,
        source: r.source,
        docType: r.doc_type,
        filedAt: r.filed_at,
        feedReportedDate: typeof meta.feed_pub_date === 'string' ? meta.feed_pub_date : null,
        canonicalDate: typeof meta.canonical_pub_date === 'string' ? meta.canonical_pub_date : null,
        isPrimary: r.is_primary_source,
      };
    });

    // Total corpus size (head-only count) — informational, no window filter.
    const totalRes = await sb.from('documents').select('id', { count: 'exact', head: true });
    const total = totalRes.count ?? 0;

    // Per-source coverage stats — count + last-filed within window.
    const { data: latestPerSource } = await sb
      .from('documents')
      .select('source, filed_at')
      .gte('filed_at', cutoff)
      .order('filed_at', { ascending: false })
      .limit(1000);
    type LatestRow = { source: string; filed_at: string | null };
    const agg = new Map<string, { count: number; lastFiledAt: string | null }>();
    for (const r of (latestPerSource ?? []) as LatestRow[]) {
      const slot = agg.get(r.source) ?? { count: 0, lastFiledAt: null };
      slot.count += 1;
      if (r.filed_at && (!slot.lastFiledAt || r.filed_at > slot.lastFiledAt)) {
        slot.lastFiledAt = r.filed_at;
      }
      agg.set(r.source, slot);
    }
    const sourceStats: SourceStat[] = Array.from(agg.entries())
      .map(([source, v]) => ({ source, count: v.count, lastFiledAt: v.lastFiledAt }))
      .sort((a, b) => b.count - a.count);

    const response: LibraryResponse = {
      items,
      total,
      sourceStats,
      refreshedAt: new Date().toISOString(),
      windowDays: daysBack,
    };
    return Response.json(response);
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : 'library failed',
        items: [],
        total: 0,
        sourceStats: [],
        refreshedAt: new Date().toISOString(),
        windowDays: daysBack,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
