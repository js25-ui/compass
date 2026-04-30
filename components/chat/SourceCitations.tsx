import type { CitationSource } from '@/lib/demo-data';

interface SourceCitationsProps {
  sources: CitationSource[];
}

export function SourceCitations({ sources }: SourceCitationsProps) {
  return (
    <div className="chat-sources">
      <div className="chat-sources-label">Sources Cited</div>
      {sources.map(s => (
        <div key={s.n} className="chat-source-item">
          <span className="chat-source-num">{s.n}</span>
          <div className="chat-source-detail">
            <div className="chat-source-title">{s.title}</div>
            <div className="chat-source-meta">{s.meta}</div>
            <a className="chat-source-link">View source →</a>
          </div>
        </div>
      ))}
    </div>
  );
}
