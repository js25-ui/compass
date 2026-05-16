/**
 * Temporary diagnostic — re-fetch a filing from EDGAR and run chunkText
 * on it to see what the deployed section tagger actually produces for
 * every chunk. Lets us inspect whether the income-statement table is
 * correctly tagged without going through the persistence layer.
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
  if (!target) return Response.json({ error: 'url required' }, { status: 400 });

  const res = await fetch(target, { headers: { 'User-Agent': SEC_USER_AGENT } });
  if (!res.ok) return Response.json({ error: `fetch ${res.status}` }, { status: 500 });
  const html = await res.text();
  const text = stripHtml(html);

  const chunks = chunkText(text, { docType });

  // Find the income statement table position in the original text
  const productRevenueIdx = text.search(/Product revenue\s+\$\s+[\d,]{3,}/);
  const totalRevenueLineIdx = text.search(/Total\s+\$\s+[\d,]{4,}/);

  // Map each chunk: index, charStart, section, contains-income-stmt
  const chunkSummary = chunks.map(c => ({
    index: c.index,
    section: c.section,
    charStart: c.charStart,
    charEnd: c.charEnd,
    containsProductRevenue: c.content.includes('Product revenue $') || /Product revenue\s+\$/.test(c.content),
    containsTotalRevenue: /Total\s+\$\s+1,21/.test(c.content),
    contentPreview: c.content.slice(0, 150),
  }));

  // Section counts
  const sectionCounts: Record<string, number> = {};
  for (const c of chunks) {
    const s = c.section ?? 'no-tag';
    sectionCounts[s] = (sectionCounts[s] ?? 0) + 1;
  }

  return Response.json({
    textLength: text.length,
    totalChunks: chunks.length,
    productRevenueLinePosition: productRevenueIdx,
    totalRevenueLinePosition: totalRevenueLineIdx,
    sectionCounts,
    chunks: chunkSummary.filter(c => c.containsProductRevenue || c.containsTotalRevenue).concat(
      chunkSummary.filter(c => c.section === 'income_statement').slice(0, 10),
    ),
  });
}
