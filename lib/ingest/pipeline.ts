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
import { seedFromXbrl } from '@/lib/data/financial_facts';
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

// Bumped from 5 → 10 so we routinely capture the most recent 10-Q + 10-K
// alongside the 8-K event filings. With 5, fast-filing companies (multiple
// 8-Ks in a quarter) crowded out the actual quarterly/annual reports.
const DEFAULT_MAX_FILINGS = 10;
const DEFAULT_MAX_ARTICLES = 15;
const MIN_CHUNK_CHARS = 200;
// Per-doc cap. SEC filings get up to 6 chunks each (income statement,
// MD&A, cash flow, balance sheet, notes, market_risk via section sort).
// News gets 2. The section-priority sort means the 6 we keep per filing
// are the high-value sections; boilerplate is dropped before this even
// applies via SKIP_EMBED_SECTIONS below.
const MAX_CHUNKS_PER_FILING = 6;
const MAX_CHUNKS_PER_NEWS = 2;
// Total ceiling. Tuned against Voyage's free-tier no-payment-method
// limits — 10K TPM, 3 RPM. A ~12-chunk batch at ~500 tokens each is
// ~6K tokens, comfortably under TPM. Larger batches hit 429 and the
// whole ingest fails.
const MAX_TOTAL_CHUNKS = 12;
// Sections we skip embedding entirely — boilerplate that wastes Voyage
// credits and crowds out high-value content for the section re-ranker.
const SKIP_EMBED_SECTIONS = new Set([
  'cover_page',
  'forward_looking',
  'table_of_contents',
  'signatures',
  'exhibits',
]);

// Section preference ordering. When we have more chunks for a doc than
// MAX_CHUNKS_PER_FILING, keep the ones from the most valuable sections
// first. Boilerplate sections rank last so they're the first to be cut.
const SECTION_PRIORITY: Record<string, number> = {
  income_statement: 100,
  mdna: 95,
  cash_flow: 90,
  balance_sheet: 85,
  notes: 75,
  equity_statement: 70,
  market_risk: 60,
  risk_factors: 55,
  legal_proceedings: 45,
  eight_k_item: 50,
  other_information: 40,
  controls_procedures: 30,
  signatures: 20,
  exhibits: 25,
  forward_looking: 15,
  table_of_contents: 5,
  cover_page: 5,
  news_body: 50,
  unknown: 35,
};

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
      // Also write the structured facts into financial_facts so the chat
      // agent's XBRL pre-fetch (lookup_facts) and the DCF/LBO preflight
      // share one source of truth. Without this, on-demand chat ingest
      // populated documents.metadata.facts but left financial_facts empty,
      // so quantitative-metric queries silently fell back to noisy chunk
      // retrieval.
      try {
        await seedFromXbrl(entity.id, entity.cik);
      } catch (err) {
        yield { type: 'source_error', source: 'edgar_xbrl', error: `financial_facts seed: ${(err as Error).message}` };
      }
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
    const meta: Array<{ docId: string; index: number; section: string | null }> = [];

    // Doc processing order matters because of MAX_TOTAL_CHUNKS — once we
    // hit the cap, later docs get zero chunks. For analyst research the
    // most recent 10-Q is more useful for quarterly questions than the
    // 10-K (annual coverage) or 8-Ks (event-specific), so we sort 10-Qs
    // first, then 10-Ks, then everything else by filed date.
    const docPriority = (doc: PendingDocument): number => {
      const dt = (doc.doc_type ?? '').toUpperCase();
      if (dt.startsWith('10-Q')) return 100;
      if (dt.startsWith('10-K')) return 90;
      if (dt.startsWith('20-F') || dt.startsWith('40-F')) return 85;
      if (dt.startsWith('8-K')) return 70;
      return 50;
    };
    const sortedDocs = [...chunkableDocs].sort((a, b) => {
      const dp = docPriority(b) - docPriority(a);
      if (dp !== 0) return dp;
      const at = a.filed_at ?? '';
      const bt = b.filed_at ?? '';
      return at < bt ? 1 : at > bt ? -1 : 0;
    });
    outer: for (const doc of sortedDocs) {
      // Pass doc_type so the chunker can tag each chunk with its SEC
      // section (income_statement, mdna, forward_looking, etc.).
      const allChunks = chunkText(doc.content_full!, { docType: doc.doc_type });
      const perDocCap = isSecFiling(doc.doc_type) ? MAX_CHUNKS_PER_FILING : MAX_CHUNKS_PER_NEWS;
      // Drop boilerplate sections before any ranking — never worth
      // spending Voyage credits on the cover page or table of contents.
      const filtered = allChunks.filter(c => !SKIP_EMBED_SECTIONS.has(c.section ?? 'unknown'));
      // Order by section priority (income_statement / MD&A first), then
      // preserve original position as tie-breaker. Slice to perDocCap.
      const ordered = [...filtered].sort((a, b) => {
        const ap = SECTION_PRIORITY[a.section ?? 'unknown'] ?? 35;
        const bp = SECTION_PRIORITY[b.section ?? 'unknown'] ?? 35;
        if (bp !== ap) return bp - ap;
        return a.index - b.index;
      }).slice(0, perDocCap);
      // Re-sort by original chunk index so embeddings + storage stay in
      // document-reading order for any consumer that cares.
      ordered.sort((a, b) => a.index - b.index);
      for (const c of ordered) {
        if (texts.length >= MAX_TOTAL_CHUNKS) break outer;
        texts.push(c.content);
        meta.push({ docId: doc.id, index: c.index, section: c.section ?? null });
      }
    }

    const batches = Math.ceil(texts.length / 128);
    yield { type: 'embedding', chunks: texts.length, batches };
    const embeddings = await embedTexts(texts, 'document');
    for (let i = 0; i < texts.length; i++) {
      built.push({
        documentId: meta[i].docId,
        index: meta[i].index,
        content: texts[i],
        embedding: embeddings[i],
        section: meta[i].section,
      });
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

function isSecFiling(docType: string): boolean {
  return /^(10[- ]?[qk](?:\/a)?|8[- ]?k(?:\/a)?|s[- ]?1(?:\/a)?|20[- ]?f|6[- ]?k|40[- ]?f|def\s*14a)$/i.test(docType.trim());
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
