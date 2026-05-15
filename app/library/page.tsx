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
  isPrimary: boolean;
}

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

  const load = (days: number) => {
    setLoading(true);
    setError(null);
    fetch(`/api/library?limit=300&days_back=${days}`)
      .then(r => r.json())
      .then((j: LibraryResponse) => {
        if (j.error) throw new Error(j.error);
        setData(j);
      })
      .catch(err => setError(err instanceof Error ? err.message : 'load failed'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(daysBack); }, [daysBack]);

  const items = data?.items ?? [];
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
        <button className="library-refresh" onClick={() => load(daysBack)} disabled={loading}>
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
              {filtered.map(item => (
                <tr key={item.documentId}>
                  <td className="lib-td-num">{item.filedAt ? item.filedAt.slice(0, 10) : '—'}</td>
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
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
