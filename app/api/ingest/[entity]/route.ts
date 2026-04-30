import { NextRequest } from 'next/server';
import { ingestEntity } from '@/lib/ingest/pipeline';
import { parseTimeRange } from '@/lib/queries/time_range';
import type { IngestMode } from '@/lib/ingest/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface RouteContext {
  params: Promise<{ entity: string }>;
}

/**
 * Streaming on-demand entity ingestion.
 *
 *   GET /api/ingest/{entity}?mode=full|numerical&time=Q1+2024&force=1
 *
 * Emits newline-delimited JSON events (NDJSON). Each line is one IngestEvent.
 * Suitable for `fetch().body.getReader()` consumption from the chat UI.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const { entity } = await ctx.params;
  const decoded = decodeURIComponent(entity);

  const url = new URL(request.url);
  const mode = (url.searchParams.get('mode') as IngestMode | null) ?? 'full';
  const force = url.searchParams.get('force') === '1';
  const timeQuery = url.searchParams.get('time');
  const timeRange = timeQuery ? parseTimeRange(timeQuery) ?? undefined : undefined;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of ingestEntity(decoded, { mode, forceRefresh: force, timeRange })) {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        controller.enqueue(encoder.encode(JSON.stringify({ type: 'error', error: message }) + '\n'));
      } finally {
        controller.close();
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
