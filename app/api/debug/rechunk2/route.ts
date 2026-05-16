/**
 * Inspect specific chunk content from a fresh re-chunk run.
 * GET /api/debug/rechunk2?url=...&indices=29,30,31,32
 */
import { NextRequest } from 'next/server';
import { chunkText } from '@/lib/retrieval/chunking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SEC_USER_AGENT = process.env.SEC_USER_AGENT ?? 'compass-test test@example.com';

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  const docType = url.searchParams.get('doc_type') ?? '10-Q';
  const indicesParam = url.searchParams.get('indices') ?? '';
  if (!target) return Response.json({ error: 'url required' }, { status: 400 });
  const indices = new Set(indicesParam.split(',').filter(Boolean).map(s => parseInt(s, 10)));

  const res = await fetch(target, { headers: { 'User-Agent': SEC_USER_AGENT } });
  if (!res.ok) return Response.json({ error: `fetch ${res.status}` }, { status: 500 });
  const html = await res.text();
  const text = stripHtml(html);

  const chunks = chunkText(text, { docType });

  const out = chunks
    .filter(c => indices.size === 0 || indices.has(c.index))
    .map(c => ({
      index: c.index,
      section: c.section,
      charStart: c.charStart,
      charEnd: c.charEnd,
      length: c.content.length,
      content: c.content,
    }));

  // Patterns we tested
  const patterns = {
    productRevDollar: /Product revenue\s*\$\s*[\d,]{4,}/i,
    productRevAny: /Product revenue\s+[\d,]{4,}/i,
    revenuesDoubleDollar: /\bRevenues?\s*\$\s*[\d,]{4,}\s*\$\s*[\d,]{4,}/i,
    revenuesDoubleNum: /\bRevenues?\s+[\d,]{4,}\s+[\d,]{4,}/i,
    nrr: /Net revenue retention rate/i,
    rpo: /Remaining performance obligations/i,
  };

  const matches: Record<string, Array<{ index: number; start: number; preview: string }>> = {};
  for (const [name, re] of Object.entries(patterns)) {
    matches[name] = [];
    const m = text.match(new RegExp(re.source, re.flags + 'g'));
    if (m) {
      let pos = 0;
      for (const found of m) {
        const idx = text.indexOf(found, pos);
        pos = idx + found.length;
        // Find which chunk this lies in
        const containing = chunks.find(c => c.charStart <= idx && idx < c.charEnd);
        matches[name].push({
          index: containing?.index ?? -1,
          start: idx,
          preview: text.slice(Math.max(0, idx - 30), idx + 200),
        });
      }
    }
  }

  return Response.json({ chunks: out, patternMatches: matches });
}
