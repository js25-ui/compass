/**
 * Seed Compass DB with the 5 demo targets and their feed/diligence/MC/memo/monitor/action records.
 * Run: pnpm seed
 *
 * Requires:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional:
 *   VOYAGE_API_KEY  (if set, computes voyage-3 embeddings for chunks; otherwise null vectors)
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  actionByBL,
  demoTargets,
  dilByBL,
  feedByBL,
  memoByBL,
  metricsByBL,
  mcByBL,
  monitorByBL,
  type BusinessLine,
  type DemoTarget,
  type FeedItem,
} from '../lib/demo-data';

function loadDotenv(): void {
  const envPath = resolve(process.cwd(), '.env.local');
  try {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // .env.local missing; fall back to process env
  }
}

loadDotenv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing Supabase env. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const VOYAGE_DIMS = 1024;

async function embed(texts: string[]): Promise<(number[] | null)[]> {
  if (!VOYAGE_API_KEY) return texts.map(() => null);
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({ input: texts, model: 'voyage-3', input_type: 'document' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Voyage embedding failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data.map(d => d.embedding);
}

async function upsertTargets(): Promise<void> {
  const rows = demoTargets.map((t: DemoTarget) => ({
    id: t.id,
    name: t.title,
    ticker: t.ticker ?? null,
    cik: null,
    business_line: t.bl,
    asset_class: assetClassFor(t.bl),
    metadata: null,
  }));
  const { error } = await sb.from('targets').upsert(rows, { onConflict: 'id' });
  if (error) throw error;
  console.log(`✓ Upserted ${rows.length} targets`);
}

function assetClassFor(bl: BusinessLine): string {
  if (bl === 'ecm') return 'ipos';
  if (bl === 'dcm') return 'ig-corporate';
  return 'private-equity';
}

async function clearDocsAndRuns(targetIds: string[]): Promise<void> {
  // Cascading deletes will remove chunks via documents FK.
  await sb.from('documents').delete().in('target_id', targetIds);
  await sb.from('model_runs').delete().in('target_id', targetIds);
  console.log('✓ Cleared existing documents + model_runs for demo targets');
}

function feedDocId(target: DemoTarget, idx: number): string {
  return `${target.id}-feed-${idx}`;
}

async function seedFeed(target: DemoTarget): Promise<{ docId: string; item: FeedItem }[]> {
  const items = feedByBL[target.bl];
  const docs = items.map((item, idx) => ({
    id: feedDocId(target, idx),
    target_id: target.id,
    source: sourceFor(item.source),
    doc_type: 'feed',
    title: item.title,
    url: null,
    content_full: `${item.title}\n\n${item.snippet}`,
    filed_at: new Date(item.date).toISOString(),
    metadata: { kind: 'feed' as const, item },
    is_primary_source: item.tagClass === 'filing' || item.tagClass === 'regulatory',
  }));
  const { error } = await sb.from('documents').upsert(docs, { onConflict: 'id' });
  if (error) throw error;
  return docs.map(d => ({ docId: d.id, item: items.find(i => i.title === d.title)! }));
}

function sourceFor(source: string): string {
  const s = source.toLowerCase();
  if (s.includes('sec')) return 'sec_edgar';
  if (s.includes('fred')) return 'fred';
  if (s.includes('msrb')) return 'msrb';
  if (s.includes('federal reserve')) return 'fed';
  return 'news_rss';
}

async function seedFlatDoc(
  target: DemoTarget,
  docType: string,
  title: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const id = `${target.id}-${docType}`;
  const { error } = await sb.from('documents').upsert(
    [
      {
        id,
        target_id: target.id,
        source: 'compass_internal',
        doc_type: docType,
        title,
        url: null,
        content_full: null,
        filed_at: new Date().toISOString(),
        metadata,
        is_primary_source: false,
      },
    ],
    { onConflict: 'id' },
  );
  if (error) throw error;
}

async function seedChunks(docs: { docId: string; item: FeedItem }[]): Promise<void> {
  const texts = docs.map(d => `${d.item.title}\n\n${d.item.snippet}`);
  const embeddings = await embed(texts);
  const rows = docs.map((d, idx) => ({
    document_id: d.docId,
    chunk_index: 0,
    content: texts[idx],
    embedding: embeddings[idx] ?? new Array(VOYAGE_DIMS).fill(0),
    page_number: null,
    section: null,
    metadata: null,
  }));
  const { error } = await sb.from('chunks').insert(rows);
  if (error) throw error;
  const note = VOYAGE_API_KEY ? 'voyage-3 embeddings' : 'zero-vector placeholders (set VOYAGE_API_KEY to compute real embeddings)';
  console.log(`  ↳ Inserted ${rows.length} chunks (${note})`);
}

async function seedModelRun(target: DemoTarget): Promise<void> {
  const { error } = await sb.from('model_runs').insert([
    {
      target_id: target.id,
      model_type: 'monte_carlo',
      inputs: { source: 'demo-seed', bl: target.bl },
      outputs: { kind: 'monte_carlo' as const, config: mcByBL[target.bl] },
      seed: 42,
      trials: 10000,
    },
  ]);
  if (error) throw error;
}

async function main(): Promise<void> {
  console.log(`Seeding Compass DB at ${SUPABASE_URL}`);
  console.log(`Voyage embeddings: ${VOYAGE_API_KEY ? 'ON' : 'OFF (zero-vector placeholders)'}\n`);

  await upsertTargets();
  await clearDocsAndRuns(demoTargets.map(t => t.id));

  for (const target of demoTargets) {
    console.log(`→ ${target.title} (${target.id})`);
    const feedDocs = await seedFeed(target);
    await seedChunks(feedDocs);

    await seedFlatDoc(target, 'diligence', `${target.title} · Diligence`, {
      kind: 'diligence' as const,
      items: dilByBL[target.bl],
    });
    await seedFlatDoc(target, 'memo', memoByBL[target.bl].title, {
      kind: 'memo' as const,
      memo: memoByBL[target.bl],
    });
    await seedFlatDoc(target, 'action', `${target.title} · Action Recommendation`, {
      kind: 'action' as const,
      data: actionByBL[target.bl],
    });
    await seedFlatDoc(target, 'monitor', `${target.title} · Monitor`, {
      kind: 'monitor' as const,
      data: monitorByBL[target.bl],
    });
    await seedFlatDoc(target, 'metrics', `${target.title} · Market Signals`, {
      kind: 'metrics' as const,
      metrics: metricsByBL[target.bl],
    });
    await seedModelRun(target);
    console.log(`  ↳ flat docs + monte_carlo run inserted`);
  }

  console.log('\n✓ Seed complete.');
}

main().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
