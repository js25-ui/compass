export interface CitedSource {
  n: number;
  title: string;
  url?: string | null;
  source?: string;
  docType?: string;
  filedAt?: string | null;
  isPrimary?: boolean;
  similarity?: number;
  // Legacy fallback (Phase 1 demo data)
  meta?: string;
}

type DateProvenance = 'sec_filed' | 'canonical' | 'feed_reported' | 'unknown' | null;

/**
 * Best-effort provenance label for the displayed filed_at on a citation.
 *  - SEC EDGAR → always canonical (EDGAR filing date is authoritative)
 *  - news.google.com URL → feed-reported (Google News' opaque redirects
 *    can't be followed server-side, so the date is the aggregator's
 *    index time)
 *  - Known direct publisher → canonical (we fetched the article's
 *    article:published_time meta tag)
 *  - Anything else → unknown (don't make a claim either way)
 *  - Compass-internal sources (deliverable pipelines) → null (no badge)
 */
function dateProvenanceFor(source: string | undefined, url: string | null | undefined): DateProvenance {
  if (!source) return null;
  if (source === 'sec_edgar') return 'sec_filed';
  if (source === 'compass_internal') return null;
  if (source !== 'news_rss' && source !== 'gdelt') return null;
  if (!url) return 'unknown';
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'news.google.com') return 'feed_reported';
    if (DIRECT_PUBLISHER_HOSTS.has(host)) return 'canonical';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

const DIRECT_PUBLISHER_HOSTS = new Set([
  'finance.yahoo.com', 'www.yahoo.com', 'www.fool.com', 'www.reuters.com',
  'www.bloomberg.com', 'www.cnbc.com', 'www.wsj.com', 'www.ft.com',
  'seekingalpha.com', 'www.marketwatch.com', 'www.barrons.com',
  'www.businesswire.com', 'www.prnewswire.com', '247wallst.com',
  'www.dailypolitical.com',
]);

const PROVENANCE_LABEL: Record<Exclude<DateProvenance, null>, { text: string; title: string; tone: 'good' | 'soft' | 'warn' }> = {
  sec_filed: { text: 'SEC filed', title: 'Date is the SEC EDGAR filing date — authoritative.', tone: 'good' },
  canonical: { text: 'canonical', title: 'Date sourced from the article\'s own published-time metadata.', tone: 'good' },
  feed_reported: { text: 'feed-reported', title: 'Date is what the news aggregator reported — may reflect when the syndicator re-published, not the original.', tone: 'warn' },
  unknown: { text: 'date unverified', title: 'Could not verify the published time against the article\'s own metadata.', tone: 'soft' },
};

interface SourceCitationsProps {
  sources: CitedSource[];
}

function metaFor(s: CitedSource): string {
  if (s.meta) return s.meta;
  const parts: string[] = [];
  if (s.source) parts.push(prettySource(s.source));
  if (s.docType) parts.push(s.docType);
  if (s.filedAt) parts.push(new Date(s.filedAt).toISOString().slice(0, 10));
  return parts.join(' · ');
}

function prettySource(source: string): string {
  if (source === 'sec_edgar') return 'SEC EDGAR';
  if (source === 'news_rss') return 'News';
  if (source === 'gdelt') return 'GDELT';
  if (source === 'fred') return 'FRED';
  if (source === 'compass_internal') return 'Compass Model';
  return source;
}

export function SourceCitations({ sources }: SourceCitationsProps) {
  if (sources.length === 0) return null;
  return (
    <div className="chat-sources">
      <div className="chat-sources-label">Sources Cited</div>
      {sources.map(s => {
        const provenance = dateProvenanceFor(s.source, s.url);
        const badge = provenance ? PROVENANCE_LABEL[provenance] : null;
        const linkContent = (
          <>
            <div className="chat-source-title">{s.title}</div>
            <div className="chat-source-meta">
              {metaFor(s)}
              {badge && s.filedAt ? (
                <span
                  className={`chat-source-provenance chat-source-provenance-${badge.tone}`}
                  title={badge.title}
                >
                  {' · '}{badge.text}
                </span>
              ) : null}
              {typeof s.similarity === 'number' ? ` · sim ${s.similarity.toFixed(2)}` : ''}
            </div>
            {s.url && (
              <a className="chat-source-link" href={s.url} target="_blank" rel="noreferrer">
                View source →
              </a>
            )}
          </>
        );
        return (
          <div key={s.n} id={`source-${s.n}`} className="chat-source-item">
            <span className="chat-source-num">{s.n}</span>
            <div className="chat-source-detail">{linkContent}</div>
          </div>
        );
      })}
    </div>
  );
}
