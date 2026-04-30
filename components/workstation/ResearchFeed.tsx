import { subtagsByBL, type BusinessLine, type FeedItem, type Metric } from '@/lib/demo-data';

interface ResearchFeedProps {
  bl: BusinessLine;
  feed: FeedItem[];
  metrics: Metric[];
  quickQs: string[];
  activeSubtag: string;
  onSubtagChange: (id: string) => void;
}

export function ResearchFeed({ bl, feed, metrics, quickQs, activeSubtag, onSubtagChange }: ResearchFeedProps) {
  const subtags = subtagsByBL[bl];

  return (
    <>
      <div className="subtag-bar">
        {subtags.map(t => (
          <div
            key={t.id}
            className={`subtag${t.id === activeSubtag ? ' active' : ''}`}
            onClick={() => onSubtagChange(t.id)}
          >
            {t.name}
          </div>
        ))}
      </div>
      <div className="stage-content">
        <div className="stage-intro">
          <h3>Research</h3>
          <p>Live feed of pricing announcements, filings, regulatory data, and news for the selected business line.</p>
        </div>
        <div className="agent-status">
          <div className="status-line done"><span className="status-icon">✓</span><span>Pulled S-1 from SEC EDGAR · 412 pages indexed</span></div>
          <div className="status-line done"><span className="status-icon">✓</span><span>Retrieved 14 IPO comps from past 18 months</span></div>
          <div className="status-line done"><span className="status-icon">✓</span><span>Indexed 38 sell-side research notes and news articles</span></div>
          <div className="status-line done"><span className="status-icon">✓</span><span>Live IPO market data from Renaissance Capital and Dealogic</span></div>
        </div>
        <div className="research-grid">
          <div className="feed-section">
            <h2>Latest Documents and News</h2>
            {feed.map(item => (
              <div key={item.title} className="feed-item fade-in">
                <div className="feed-meta">
                  <span className={`feed-tag ${item.tagClass}`}>{item.tag}</span>
                  <span>{item.date}</span>
                  <span>{item.type}</span>
                </div>
                <div className="feed-title">{item.title}</div>
                <div className="feed-snippet">{item.snippet}</div>
                <div className="feed-source"><span>Source:</span> {item.source}</div>
              </div>
            ))}
          </div>
          <div>
            <div className="data-card">
              <h3>Market Signals</h3>
              {metrics.map(m => {
                const cls = m.trend === 'up' ? ' up' : m.trend === 'down' ? ' down' : '';
                return (
                  <div key={m.label} className="metric-row">
                    <span className="metric-label">{m.label}</span>
                    <span className={`metric-value${cls}`}>{m.value}</span>
                  </div>
                );
              })}
            </div>
            <div className="data-card">
              <h3>Quick Research</h3>
              <ul className="quick-q-list">
                {quickQs.map(q => (
                  <li key={q} className="quick-q-item">{q}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
