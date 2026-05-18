'use client';

import { useEffect, useMemo, useState } from 'react';

interface LibraryItem {
  documentId: string;
  targetId: string | null;
  title: string;
  url: string | null;
  source: string;
  docType: string;
  filedAt: string | null;
  feedReportedDate?: string | null;
  canonicalDate?: string | null;
  isPrimary: boolean;
}

type DateProvenance = 'sec_filed' | 'canonical' | 'feed_reported' | 'unknown';

const DIRECT_PUBLISHER_HOSTS = new Set([
  'finance.yahoo.com', 'www.yahoo.com', 'www.fool.com', 'www.reuters.com',
  'www.bloomberg.com', 'www.cnbc.com', 'www.wsj.com', 'www.ft.com',
  'seekingalpha.com', 'www.marketwatch.com', 'www.barrons.com',
  'www.businesswire.com', 'www.prnewswire.com', '247wallst.com',
  'www.dailypolitical.com',
]);

/**
 * Date provenance for a library row. Authoritative sources (SEC EDGAR,
 * canonical fetch) get a "good" tag; aggregator-reported dates (Google
 * News' opaque redirects) get a "warn" tag so the user sees the date
 * may reflect syndication time, not the original publication.
 */
function dateProvenanceFor(item: LibraryItem): DateProvenance | null {
  if (item.source === 'sec_edgar') return 'sec_filed';
  if (item.source !== 'news_rss' && item.source !== 'gdelt') return null;
  // Prefer the metadata signal when present.
  if (item.canonicalDate) return 'canonical';
  if (!item.url) return 'unknown';
  try {
    const host = new URL(item.url).hostname.toLowerCase();
    if (host === 'news.google.com') return 'feed_reported';
    if (DIRECT_PUBLISHER_HOSTS.has(host)) return 'canonical';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

const PROVENANCE_PILL: Record<DateProvenance, { label: string; title: string; tone: 'good' | 'warn' | 'soft' }> = {
  sec_filed: { label: 'SEC', title: 'Date is the SEC EDGAR filing date — authoritative.', tone: 'good' },
  canonical: { label: 'canonical', title: 'Date sourced from the article\'s own published-time meta tag.', tone: 'good' },
  feed_reported: { label: 'feed', title: 'Aggregator-reported (Google News). May be syndication time, not original publication.', tone: 'warn' },
  unknown: { label: '?', title: 'Could not verify against the article\'s own metadata.', tone: 'soft' },
};

interface SourceStat {
  source: string;
  count: number;
  lastFiledAt: string | null;
}

interface LibraryResponse {
  items: LibraryItem[];
  total: number;
  sourceStats: SourceStat[];
  refreshedAt: string;
  windowDays: number;
  error?: string;
}

const SOURCE_LABELS: Record<string, string> = {
  sec_edgar: 'SEC EDGAR',
  news_rss: 'News RSS',
  gdelt: 'GDELT',
  fred: 'FRED',
};

export default function LibraryPage() {
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [docTypeFilter, setDocTypeFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [daysBack, setDaysBack] = useState(30);
  // Bump refreshNonce to force the fetch effect to re-run (e.g. when the
  // user clicks Refresh while daysBack is unchanged).
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Fetch entirely inside an async IIFE so every setState lands after at
  // least one await — satisfies react-hooks/set-state-in-effect by keeping
  // updates out of the effect's synchronous body.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/library?limit=300&days_back=${daysBack}`);
        const j = (await res.json()) as LibraryResponse;
        if (cancelled) return;
        if (j.error) {
          setError(j.error);
          setData(null);
        } else {
          setData(j);
          setError(null);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'load failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [daysBack, refreshNonce]);

  const triggerRefresh = () => setRefreshNonce(n => n + 1);

  const items = useMemo(() => data?.items ?? [], [data]);
  const sourceStats = data?.sourceStats ?? [];

  const docTypes = useMemo(() => {
    const set = new Set(items.map(i => i.docType));
    return ['all', ...Array.from(set).sort()];
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(i => {
      if (sourceFilter !== 'all' && i.source !== sourceFilter) return false;
      if (docTypeFilter !== 'all' && i.docType !== docTypeFilter) return false;
      if (q && !i.title.toLowerCase().includes(q) && !(i.targetId ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, search, sourceFilter, docTypeFilter]);

  const lastRefreshText = data?.refreshedAt ? new Date(data.refreshedAt).toLocaleTimeString() : '—';
  const newestInCorpus = items[0]?.filedAt ? items[0].filedAt.slice(0, 10) : '—';

  return (
    <div className="library-page">
      <header className="library-header">
        <div>
          <div className="library-eyebrow">Corpus Library</div>
          <h1 className="library-title">Browse everything Compass has indexed</h1>
          <p className="library-sub">
            Every document the discovery engine has gathered. Filterable by source, type, and entity.
            The corpus refreshes on demand whenever a deliverable touches an entity that lacks coverage.
          </p>
        </div>
        <div className="library-stats">
          <div className="library-stat">
            <div className="library-stat-label">In window</div>
            <div className="library-stat-value">{filtered.length} / {items.length}</div>
          </div>
          <div className="library-stat">
            <div className="library-stat-label">Corpus total</div>
            <div className="library-stat-value">{data?.total ?? '—'}</div>
          </div>
          <div className="library-stat">
            <div className="library-stat-label">Window</div>
            <div className="library-stat-value">{daysBack}d</div>
          </div>
          <div className="library-stat">
            <div className="library-stat-label">Newest filing</div>
            <div className="library-stat-value">{newestInCorpus}</div>
          </div>
          <div className="library-stat">
            <div className="library-stat-label">Refreshed</div>
            <div className="library-stat-value">{lastRefreshText}</div>
          </div>
        </div>
      </header>

      {sourceStats.length > 0 && (
        <div className="source-strip">
          <div className="source-strip-label">Source coverage (last {daysBack}d)</div>
          <div className="source-strip-row">
            {sourceStats.map(s => (
              <button
                key={s.source}
                className={`source-chip${sourceFilter === s.source ? ' active' : ''}`}
                onClick={() => setSourceFilter(prev => prev === s.source ? 'all' : s.source)}
              >
                <span className="source-chip-name">{SOURCE_LABELS[s.source] ?? s.source}</span>
                <span className="source-chip-count">{s.count}</span>
                <span className="source-chip-meta">
                  {s.lastFiledAt ? `last ${s.lastFiledAt.slice(0, 10)}` : 'no recent filing'}
                </span>
              </button>
            ))}
            {sourceFilter !== 'all' ? (
              <button className="source-chip-clear" onClick={() => setSourceFilter('all')}>
                Clear filter
              </button>
            ) : null}
          </div>
        </div>
      )}

      <div className="library-controls">
        <input
          type="text"
          className="library-search"
          placeholder="Search title or entity…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select className="library-select" value={docTypeFilter} onChange={e => setDocTypeFilter(e.target.value)}>
          {docTypes.map(t => <option key={t} value={t}>{t === 'all' ? 'All types' : t}</option>)}
        </select>
        <select className="library-select" value={daysBack} onChange={e => setDaysBack(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
          <option value={60}>Last 60 days</option>
          <option value={180}>Last 180 days</option>
          <option value={365}>Last year</option>
        </select>
        <button className="library-refresh" onClick={triggerRefresh} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error ? <div className="library-error">Load error: {error}</div> : null}

      <div className="library-table-wrap">
        {filtered.length === 0 && !loading ? (
          <div className="library-empty">No items match the current filters.</div>
        ) : (
          <table className="library-table">
            <thead>
              <tr>
                <th>Filed</th>
                <th>Source</th>
                <th>Type</th>
                <th>Entity</th>
                <th>Title</th>
                <th>Primary</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => {
                const provenance = dateProvenanceFor(item);
                const pill = provenance ? PROVENANCE_PILL[provenance] : null;
                return (
                  <tr key={item.documentId}>
                    <td className="lib-td-num">
                      {item.filedAt ? item.filedAt.slice(0, 10) : '—'}
                      {pill ? (
                        <span
                          className={`lib-provenance-pill lib-provenance-${pill.tone}`}
                          title={pill.title}
                        >
                          {pill.label}
                        </span>
                      ) : null}
                    </td>
                    <td className="lib-td-muted">{SOURCE_LABELS[item.source] ?? item.source}</td>
                    <td className="lib-td-muted">{item.docType}</td>
                    <td className="lib-td-muted">{item.targetId ?? '—'}</td>
                    <td>
                      {item.url
                        ? <a className="library-link" href={item.url} target="_blank" rel="noreferrer">{item.title}</a>
                        : item.title}
                    </td>
                    <td>{item.isPrimary ? <span className="lib-primary-pill">primary</span> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
