import type { ResolvedEntity } from '@/lib/lookup/resolve';
import type { TimeRange } from '@/lib/queries/time_range';

export type IngestMode = 'numerical' | 'full';
export type SourceName = 'edgar_filings' | 'edgar_xbrl' | 'fred' | 'news_rss' | 'gdelt';

export interface IngestOptions {
  /** 'numerical' = XBRL only (fast, no embedding); 'full' = filings + news + chunked + embedded. */
  mode?: IngestMode;
  /** Optional time range filter for filings/macro/news. */
  timeRange?: TimeRange;
  /** Skip cache check; re-fetch even if target is already indexed. */
  forceRefresh?: boolean;
  /** Cap on EDGAR filings to fetch (default 5). */
  maxFilings?: number;
  /** Cap on news + GDELT articles to fetch (default 25 each). */
  maxArticles?: number;
}

export type IngestEvent =
  | { type: 'resolving'; query: string }
  | { type: 'resolved'; entity: ResolvedEntity }
  | { type: 'unresolved'; query: string; reason: string }
  | { type: 'cached'; targetId: string; documents: number; chunks: number }
  | { type: 'fetching'; source: SourceName }
  | { type: 'fetched'; source: SourceName; count: number; durationMs: number }
  | { type: 'source_error'; source: SourceName; error: string }
  | { type: 'chunking'; documents: number }
  | { type: 'embedding'; chunks: number; batches: number }
  | { type: 'persisting' }
  | {
      type: 'done';
      targetId: string;
      documentsAdded: number;
      chunksAdded: number;
      durationMs: number;
    }
  | { type: 'error'; error: string };
