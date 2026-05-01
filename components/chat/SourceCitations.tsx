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
        const linkContent = (
          <>
            <div className="chat-source-title">{s.title}</div>
            <div className="chat-source-meta">
              {metaFor(s)}
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
