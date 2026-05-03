'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { demoTargets, type BusinessLine } from '@/lib/demo-data';

interface BLConfig {
  id: BusinessLine;
  num: string;
  name: string;
  fullname: string;
  desc: string;
  tags: string[];
}

const blConfigs: BLConfig[] = [
  { id: 'ecm', num: '01', name: 'ECM', fullname: 'Equity Capital Markets',
    desc: 'IPOs, follow-ons, secondaries, convertibles.',
    tags: ['IPOs', 'Follow-Ons', 'Convertibles'] },
  { id: 'dcm', num: '02', name: 'DCM', fullname: 'Debt Capital Markets',
    desc: 'IG, HY, leveraged loans, munis, sovereigns.',
    tags: ['IG Corp', 'HY', 'Muni', 'Sovereign'] },
  { id: 'alts', num: '03', name: 'Alternatives', fullname: 'Alternative Investments',
    desc: 'PE, hedge funds, infrastructure, private credit.',
    tags: ['PE', 'Real Estate', 'Credit', 'Infra'] },
];

interface NewsItem {
  documentId: string;
  targetId: string | null;
  title: string;
  url: string | null;
  source: string;
  docType: string;
  filedAt: string | null;
  isPrimary: boolean;
}

const SUGGESTED_TASKS = [
  'Sweetgreen pitch book',
  'Boeing bond pricing memo',
  'LBO analysis on Datadog',
  'Compare Cava and Chipotle',
  "What's new in private equity?",
  'Latest Fed commentary impact on IG',
];

export default function WorkstationLandingPage() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [news, setNews] = useState<NewsItem[]>([]);
  const [newsLoading, setNewsLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    void fetch('/api/recent-news?limit=10&days_back=14')
      .then(r => r.json())
      .then((j: { items?: NewsItem[] }) => setNews(j.items ?? []))
      .catch(() => setNews([]))
      .finally(() => setNewsLoading(false));
  }, []);

  const submit = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    router.push(`/ask/conversation?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <div className="landing-workstation">
      <div className="hero">
        <div className="hero-eyebrow">Workstation · Task-Driven Workflow</div>
        <h1 className="hero-title">Compass scopes the work, gathers the inputs, builds the deliverable.</h1>
        <p className="hero-sub">
          Type a task — pitch book, IC memo, bond pricing, LBO analysis, or any open question — and Compass
          will clarify scope, pull comps and filings, run the model, and assemble the output.
        </p>
        <div className="stages-row">
          <div className="stage-chip">01 Clarify</div>
          <div className="stage-chip">02 Gather</div>
          <div className="stage-chip">03 Model</div>
          <div className="stage-chip">04 Deliver</div>
        </div>
      </div>

      <div className="search-section">
        <div className="search-bar">
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            placeholder="Search a deal, company, or task — e.g. 'Sweetgreen pitch book'"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(search); }}
          />
          <button className="search-btn" onClick={() => submit(search)}>
            Run
          </button>
        </div>
        <div className="search-hint">
          <span>Try:</span>
          {SUGGESTED_TASKS.map(s => (
            <span key={s} onClick={() => submit(s)}>{s}</span>
          ))}
        </div>
      </div>

      <div className="recent-news-section">
        <div className="recent-news-header">
          <span className="recent-news-label">Recent Activity in the Corpus</span>
          <span className="recent-news-meta">{newsLoading ? 'Loading…' : `${news.length} items · last 14 days`}</span>
        </div>
        <div className="recent-news-grid">
          {news.map(item => (
            <article key={item.documentId} className="recent-news-card" onClick={() => submit(item.title)}>
              <div className="news-meta">
                <span className={`feed-tag ${docTypeClass(item.source, item.docType)}`}>
                  {prettyTag(item.source, item.docType)}
                </span>
                <span>{item.filedAt ? new Date(item.filedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}</span>
              </div>
              <div className="news-title">{item.title}</div>
              <div className="news-source">{prettySource(item.source)}{item.targetId ? ` · ${item.targetId}` : ''}</div>
            </article>
          ))}
          {!newsLoading && news.length === 0 && (
            <div className="recent-news-empty">
              No corpus activity yet. Submit a task above and Compass will start indexing.
            </div>
          )}
        </div>
      </div>

      <div className="bl-secondary">
        <div className="verticals-label">Or browse by business line</div>
        <div className="business-lines">
          {blConfigs.map(bl => {
            const target = demoTargets.find(t => t.bl === bl.id);
            const href = target ? `/workstation/${bl.id}/${target.id}` : '#';
            return (
              <Link key={bl.id} href={href} className="bl-tile" style={{ textDecoration: 'none' }}>
                <div className="bl-num">{bl.num}</div>
                <div className="bl-name">{bl.name}</div>
                <div className="bl-fullname">{bl.fullname}</div>
                <div className="bl-desc">{bl.desc}</div>
                <div className="bl-tags">
                  {bl.tags.map(t => <span key={t} className="bl-tag-mini">{t}</span>)}
                </div>
                <div className="bl-arrow">→</div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function docTypeClass(source: string, docType: string): string {
  if (source === 'sec_edgar') return 'filing';
  if (source === 'gdelt') return 'news';
  if (source === 'fred') return 'regulatory';
  if (docType.toLowerCase().includes('transcript')) return 'transcript';
  if (docType.toLowerCase().includes('pricing')) return 'pricing';
  return 'news';
}

function prettyTag(source: string, docType: string): string {
  if (source === 'sec_edgar') return docType.toUpperCase();
  if (source === 'fred') return 'MACRO';
  if (source === 'gdelt') return 'EVENT';
  return 'NEWS';
}

function prettySource(source: string): string {
  if (source === 'sec_edgar') return 'SEC EDGAR';
  if (source === 'news_rss') return 'News RSS';
  if (source === 'gdelt') return 'GDELT';
  if (source === 'fred') return 'FRED';
  return source;
}
