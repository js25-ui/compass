import 'server-only';
import { resolveEntity, type ResolvedEntity } from '@/lib/lookup/resolve';
import { chunkText } from '@/lib/retrieval/chunking';
import { embedTexts } from '@/lib/embeddings/voyage';
import {
  defaultMacroSeries,
  fetchEdgarFilings,
  fetchEdgarXbrl,
  fetchFredMacro,
  fetchGdelt,
  fetchNews,
  type PendingDocument,
} from './sources';
import {
  bumpLastQueried,
  getTargetSnapshot,
  recordIngestRun,
  replaceChunks,
  upsertDocuments,
  upsertTarget,
  type PendingChunk,
} from './persist';
import type { IngestEvent, IngestOptions, SourceName } from './types';

const DEFAULT_MAX_FILINGS = 5;
const DEFAULT_MAX_ARTICLES = 15;
const MIN_CHUNK_CHARS = 200;
const MAX_CHUNKS_PER_DOC = 3;
const MAX_TOTAL_CHUNKS = 20;          // hard cap; keeps Voyage usage in free-tier TPM

export async function* ingestEntity(
  query: string,
  opts: IngestOptions = {},
): AsyncGenerator<IngestEvent> {
  const startedAt = Date.now();
  const mode = opts.mode ?? 'full';
  const maxFilings = opts.maxFilings ?? DEFAULT_MAX_FILINGS;
  const maxArticles = opts.maxArticles ?? DEFAULT_MAX_ARTICLES;

  yield { type: 'resolving', query };

  const entity = await resolveEntity(query);
  if (!entity) {
    yield { type: 'unresolved', query, reason: 'no deterministic entity match' };
    return;
  }
  yield { type: 'resolved', entity };

  // Cache hit: target already indexed and not forced to refresh.
  const snapshot = await getTargetSnapshot(entity.id);
  if (!opts.forceRefresh && snapshot.exists && snapshot.status === 'indexed') {
    await bumpLastQueried(entity.id);
    yield { type: 'cached', targetId: entity.id, documents: snapshot.documents, chunks: snapshot.chunks };
    return;
  }

  await upsertTarget(entity, 'pending');

  const collected: PendingDocument[] = [];

  // ------------- EDGAR XBRL company facts (cheap, structured) -------------
  if (entity.cik) {
    yield { type: 'fetching', source: 'edgar_xbrl' };
    const t0 = Date.now();
    try {
      const docs = await fetchEdgarXbrl(entity);
      collected.push(...docs);
      yield { type: 'fetched', source: 'edgar_xbrl', count: docs.length, durationMs: Date.now() - t0 };
      await recordIngestRun({
        targetId: entity.id, source: 'edgar_xbrl', status: 'success',
        documentsAdded: docs.length, chunksAdded: 0, durationMs: Date.now() - t0,
      });
    } catch (err) {
      const message = (err as Error).message;
      yield { type: 'source_error', source: 'edgar_xbrl', error: message };
      await recordIngestRun({
        targetId: entity.id, source: 'edgar_xbrl', status: 'error',
        documentsAdded: 0, chunksAdded: 0, durationMs: Date.now() - t0, error: message,
      });
    }
  }

  // ------------- EDGAR filings (heavier; full text in 'full' mode) -------------
  if (entity.cik && mode === 'full') {
    yield { type: 'fetching', source: 'edgar_filings' };
    const t0 = Date.now();
    try {
      const docs = await fetchEdgarFilings(entity, {
        withFullText: true,
        timeRange: opts.timeRange,
        maxFilings,
      });
      collected.push(...docs);
      yield { type: 'fetched', source: 'edgar_filings', count: docs.length, durationMs: Date.now() - t0 };
      await recordIngestRun({
        targetId: entity.id, source: 'edgar_filings', status: 'success',
        documentsAdded: docs.length, chunksAdded: 0, durationMs: Date.now() - t0,
      });
    } catch (err) {
      const message = (err as Error).message;
      yield { type: 'source_error', source: 'edgar_filings', error: message };
      await recordIngestRun({
        targetId: entity.id, source: 'edgar_filings', status: 'error',
        documentsAdded: 0, chunksAdded: 0, durationMs: Date.now() - t0, error: message,
      });
    }
  }

  // ------------- News (RSS + GDELT) in parallel -------------
  const newsTasks: Array<Promise<{ source: SourceName; docs: PendingDocument[]; durationMs: number; error?: string }>> = [];
  yield { type: 'fetching', source: 'news_rss' };
  newsTasks.push(
    timeIt('news_rss', () => fetchNews(entity, { maxArticles })),
  );
  yield { type: 'fetching', source: 'gdelt' };
  newsTasks.push(
    timeIt('gdelt', () => fetchGdelt(entity, { maxArticles, timeRange: opts.timeRange })),
  );
  for (const result of await Promise.all(newsTasks)) {
    if (result.error) {
      yield { type: 'source_error', source: result.source, error: result.error };
      await recordIngestRun({
        targetId: entity.id, source: result.source, status: 'error',
        documentsAdded: 0, chunksAdded: 0, durationMs: result.durationMs, error: result.error,
      });
    } else {
      collected.push(...result.docs);
      yield { type: 'fetched', source: result.source, count: result.docs.length, durationMs: result.durationMs };
      await recordIngestRun({
        targetId: entity.id, source: result.source, status: 'success',
        documentsAdded: result.docs.length, chunksAdded: 0, durationMs: result.durationMs,
      });
    }
  }

  // ------------- FRED macro (only when key is set) -------------
  if (process.env.FRED_API_KEY) {
    yield { type: 'fetching', source: 'fred' };
    const t0 = Date.now();
    try {
      const docs = await fetchFredMacro({ series: defaultMacroSeries(entity), timeRange: opts.timeRange });
      collected.push(...docs);
      yield { type: 'fetched', source: 'fred', count: docs.length, durationMs: Date.now() - t0 };
      await recordIngestRun({
        targetId: entity.id, source: 'fred', status: 'success',
        documentsAdded: docs.length, chunksAdded: 0, durationMs: Date.now() - t0,
      });
    } catch (err) {
      const message = (err as Error).message;
      yield { type: 'source_error', source: 'fred', error: message };
      await recordIngestRun({
        targetId: entity.id, source: 'fred', status: 'error',
        documentsAdded: 0, chunksAdded: 0, durationMs: Date.now() - t0, error: message,
      });
    }
  }

  if (collected.length === 0) {
    await upsertTarget(entity, 'failed');
    yield {
      type: 'error',
      error: 'No data could be retrieved for this entity from any source.',
    };
    return;
  }

  // ------------- Chunk + embed (skipped in numerical mode) -------------
  let chunkRows: PendingChunk[] = [];
  const chunkableDocs = mode === 'full'
    ? collected.filter(d => d.content_full && d.content_full.length >= MIN_CHUNK_CHARS)
    : [];

  if (chunkableDocs.length > 0) {
    yield { type: 'chunking', documents: chunkableDocs.length };
    const built: PendingChunk[] = [];
    const texts: string[] = [];
    const meta: Array<{ docId: string; index: number }> = [];

    outer: for (const doc of chunkableDocs) {
      const chunks = chunkText(doc.content_full!).slice(0, MAX_CHUNKS_PER_DOC);
      for (const c of chunks) {
        if (texts.length >= MAX_TOTAL_CHUNKS) break outer;
        texts.push(c.content);
        meta.push({ docId: doc.id, index: c.index });
      }
    }

    const batches = Math.ceil(texts.length / 128);
    yield { type: 'embedding', chunks: texts.length, batches };
    const embeddings = await embedTexts(texts, 'document');
    for (let i = 0; i < texts.length; i++) {
      built.push({ documentId: meta[i].docId, index: meta[i].index, content: texts[i], embedding: embeddings[i] });
    }
    chunkRows = built;
  }

  // ------------- Persist -------------
  yield { type: 'persisting' };
  await upsertDocuments(entity.id, collected);
  await replaceChunks(chunkableDocs.map(d => d.id), chunkRows);
  await upsertTarget(entity, 'indexed');

  yield {
    type: 'done',
    targetId: entity.id,
    documentsAdded: collected.length,
    chunksAdded: chunkRows.length,
    durationMs: Date.now() - startedAt,
  };
}

async function timeIt(
  source: SourceName,
  fn: () => Promise<PendingDocument[]>,
): Promise<{ source: SourceName; docs: PendingDocument[]; durationMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    const docs = await fn();
    return { source, docs, durationMs: Date.now() - t0 };
  } catch (err) {
    return { source, docs: [], durationMs: Date.now() - t0, error: (err as Error).message };
  }
}

/** Convenience helper: drain the generator and collect events. Used by tests + cron. */
export async function runIngestion(query: string, opts: IngestOptions = {}): Promise<IngestEvent[]> {
  const out: IngestEvent[] = [];
  for await (const ev of ingestEntity(query, opts)) out.push(ev);
  return out;
}

export type { ResolvedEntity };
