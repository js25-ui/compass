'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { SuggestedPrompts } from './SuggestedPrompts';

const dataSources = [
  'SEC EDGAR',
  'FRED',
  'MSRB EMMA',
  'FERC',
  'NewsAPI',
  'USPTO',
  'Renaissance Capital',
  'GDELT',
];

export function ChatLanding() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const send = () => {
    const q = value.trim();
    if (!q) return;
    router.push(`/chat/conversation?q=${encodeURIComponent(q)}`);
  };

  return (
    <div className="ask-landing-page">
      <div className="ask-landing-content">
        <div className="ask-hero">
          <div className="ask-hero-eyebrow">Multi-Agent RAG · Capital Markets Intelligence</div>
          <h1>
            What do you want to <span className="accent">research</span> today?
          </h1>
          <p>
            Ask anything about a deal, company, or security. Compass runs specialized agents across
            SEC filings, news, market data, and your indexed corpus to deliver cited, grounded answers.
          </p>
        </div>

        <div className="ask-landing-input-wrap">
          <div className="ask-landing-input">
            <input
              ref={inputRef}
              type="text"
              placeholder="Ask about any deal, company, or security..."
              value={value}
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') send();
              }}
            />
            <button className="ask-landing-send" onClick={send}>Ask</button>
          </div>
        </div>

        <div className="ask-input-hint">
          <span>Multi-agent RAG · Claude Sonnet 4.6 · Voyage Embeddings</span>
          <span className="accuracy">95% citation accuracy</span>
        </div>

        <SuggestedPrompts />
      </div>

      <div className="data-sources-strip">
        <div className="data-sources-label">Live Data Sources</div>
        <div className="data-sources-list">
          {dataSources.map(src => (
            <span key={src} className="data-source-item">{src}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
