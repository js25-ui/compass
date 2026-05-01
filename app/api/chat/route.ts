import { NextRequest } from 'next/server';
import { runChatAgent } from '@/lib/agents/chat_agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { query?: string };
  const query = body.query?.trim();
  if (!query) {
    return new Response(JSON.stringify({ error: 'query is required' }), { status: 400 });
  }

  const encoder = new TextEncoder();

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
        try { controller.close(); } catch { /* already closed */ }
      };

      try {
        emit({ type: 'started', query });
        for await (const event of runChatAgent(query)) {
          emit(event);
        }
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
