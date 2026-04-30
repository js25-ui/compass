'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { UserMessage, AssistantMessage } from '@/components/chat/ChatMessage';
import { AgentActivity } from '@/components/chat/AgentActivity';
import { pickAnswer, type CitationSource } from '@/lib/demo-data';

interface UserTurn {
  id: number;
  role: 'user';
  text: string;
  time: string;
}

interface AssistantTurn {
  id: number;
  role: 'assistant';
  activity: string[];
  html: string;
  sources: CitationSource[];
  time: string;
  latencyMs: number;
  phase: 'activity' | 'answer';
}

type Turn = UserTurn | AssistantTurn;

const indexedSources = [
  { name: 'SEC EDGAR Filings', meta: '10-K · 10-Q · 8-K · S-1' },
  { name: 'FRED Macro Data', meta: 'Daily · 800K+ series' },
  { name: 'MSRB EMMA', meta: 'Muni filings · daily' },
  { name: 'News & Research', meta: 'Bloomberg · WSJ · sell-side' },
  { name: 'Compass Models', meta: 'All session outputs' },
];

const agents = ['Filings Agent', 'Comps Agent', 'News Agent', 'Model Agent', 'Macro Agent'];

function nowTimeString() {
  return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function ConversationView() {
  const params = useSearchParams();
  const initialQ = params.get('q') ?? '';

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef<string | null>(null);
  const idRef = useRef(0);

  const submit = (question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;

    const data = pickAnswer(trimmed);
    const time = nowTimeString();
    const userId = ++idRef.current;
    const assistantId = ++idRef.current;

    setTurns(prev => [
      ...prev,
      { id: userId, role: 'user', text: data.user, time },
      {
        id: assistantId,
        role: 'assistant',
        activity: data.activity,
        html: data.answer,
        sources: data.sources,
        time,
        latencyMs: data.latencyMs,
        phase: 'activity',
      },
    ]);

    setTimeout(() => {
      setTurns(prev =>
        prev.map(t => (t.id === assistantId && t.role === 'assistant' ? { ...t, phase: 'answer' } : t)),
      );
    }, 1000);
  };

  useEffect(() => {
    if (initialQ && seededRef.current !== initialQ) {
      seededRef.current = initialQ;
      submit(initialQ);
    }
  }, [initialQ]);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const handleSend = () => {
    submit(input);
    setInput('');
  };

  const lastAssistant = [...turns].reverse().find((t): t is AssistantTurn => t.role === 'assistant');
  const headerContext = lastAssistant
    ? `Live agentic retrieval · ${lastAssistant.sources.length} sources · grounded`
    : 'Querying live data sources';

  return (
    <div className="ask-conversation-page">
      <div className="ask-conversation-header">
        <div className="ask-context-left">
          <span className="ask-context-tag">Multi-Agent RAG</span>
          <span>{headerContext}</span>
        </div>
        <div className="ask-context-right">
          <span className="accuracy">95% citation accuracy</span>
          <Link href="/ask" className="new-chat-btn">+ New Chat</Link>
        </div>
      </div>

      <div className="ask-conversation-workspace">
        <div className="chat-main">
          <div className="chat-messages" ref={containerRef}>
            {turns.map(turn => {
              if (turn.role === 'user') {
                return <UserMessage key={turn.id} text={turn.text} time={turn.time} />;
              }
              return (
                <div key={turn.id}>
                  <AgentActivity lines={turn.activity} />
                  {turn.phase === 'answer' && (
                    <AssistantMessage
                      html={turn.html}
                      sources={turn.sources}
                      time={turn.time}
                      latencyMs={turn.latencyMs}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div className="chat-input-area">
            <div className="chat-input-row">
              <input
                type="text"
                placeholder="Continue the conversation..."
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSend();
                }}
              />
              <button className="chat-send-btn" onClick={handleSend}>Send</button>
            </div>
            <div className="chat-input-hint">
              <span>Press Enter to send</span>
              <span>Multi-agent RAG · grounded answers with citations</span>
            </div>
          </div>
        </div>

        <aside className="ask-side">
          <div className="ask-side-section">
            <div className="ask-side-label">Indexed Sources</div>
            {indexedSources.map(s => (
              <div key={s.name} className="indexed-doc">
                <div className="indexed-doc-name">{s.name}</div>
                <div className="indexed-doc-meta">{s.meta}</div>
              </div>
            ))}
          </div>

          <div className="ask-side-section">
            <div className="ask-side-label">Active Agents</div>
            {agents.map(a => (
              <div key={a} className="agent-card">
                <span className="agent-name">{a}</span>
                <span className="agent-state">Ready</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

export default function ConversationPage() {
  return (
    <Suspense fallback={<div className="ask-conversation-page" />}>
      <ConversationView />
    </Suspense>
  );
}
