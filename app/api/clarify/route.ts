import { NextRequest } from 'next/server';
import { clarifyScope } from '@/lib/agents/clarify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { query?: string };
  const query = body.query?.trim();
  if (!query) {
    return new Response(JSON.stringify({ error: 'query is required' }), { status: 400 });
  }
  try {
    const output = await clarifyScope(query);
    return Response.json(output);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'clarify failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
