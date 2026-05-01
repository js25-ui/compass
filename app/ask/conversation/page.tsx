'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { UserMessage, AssistantMessage } from '@/components/chat/ChatMessage';
import { AgentActivity } from '@/components/chat/AgentActivity';

interface UserTurn {
  id: number;
  role: 'user';
  text: string;
  time: string;
}

interface ChatSource {
  n: number;
  title: string;
  url: string | null;
  source: string;
  docType: string;
  filedAt: string | null;
  isPrimary: boolean;
  similarity: number;
}

interface AssistantTurn {
  id: number;
  role: 'assistant';
  activity: string[];
  html: string;
  sources: ChatSource[];
  time: string;
  latencyMs: number;
  phase: 'streaming' | 'done';
  error?: string;
}

type Turn = UserTurn | AssistantTurn;

const indexedSources = [
  { name: 'SEC EDGAR Filings', meta: '10-K · 10-Q · 8-K · S-1 · DEF 14A' },
  { name: 'SEC XBRL Financial Facts', meta: 'Annual + quarterly · 1993+' },
  { name: 'News (Yahoo + Google)', meta: 'Per-ticker + query RSS' },
  { name: 'GDELT Event Stream', meta: 'Global news + events' },
  { name: 'FRED Macro Data', meta: 'Treasuries · OAS · VIX · CPI' },
];

const agents = [
  { name: 'Orchestrator', model: 'Haiku 4.5' },
  { name: 'Resolver', model: 'SEC + curated' },
  { name: 'Ingestor', model: 'pipeline' },
  { name: 'Retriever', model: 'pgvector + Voyage' },
  { name: 'Memo Agent', model: 'Sonnet 4.5' },
];

function nowTimeString() {
  return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function activityLabelFor(event: ChatEvent): string | null {
  switch (event.type) {
    case 'extracting': return 'Orchestrator · extracting entities';
    case 'extracted': {
      const names = event.entities.map(e => e.ticker ?? e.name).join(', ');
      return event.entities.length > 0
        ? `Resolved: ${names}`
        : `Couldn't resolve any entity from the query`;
    }
    case 'ingesting': return `Ingesting ${event.entity} (full mode)`;
    case 'ingest_progress': {
      const nested = event.event;
      if (nested.type === 'fetched') {
        return `${event.entity} · ${nested.source} → ${nested.count} docs`;
      }
      if (nested.type === 'done') {
        return `${event.entity} · indexed ${nested.documentsAdded} docs, ${nested.chunksAdded} chunks`;
      }
      return null;
    }
    case 'ingest_complete': return `${event.entity} ready`;
    case 'cache_hit': return `${event.entity} already indexed (${event.documents} docs, ${event.chunks} chunks)`;
    case 'retrieving': return `Vector search · top ${event.topK}`;
    case 'retrieved': return `Retrieved ${event.chunkCount} chunks`;
    case 'thinking': return 'Memo Agent · synthesizing answer';
    default: return null;
  }
}

interface ExtractedEntity { id: string; name: string; ticker?: string }
type ChatEvent =
  | { type: 'started'; query: string }
  | { type: 'extracting' }
  | { type: 'extracted'; entities: ExtractedEntity[]; unresolved: { name: string }[]; intent: string; isHistorical: boolean }
  | { type: 'clarification_needed'; question: string }
  | { type: 'cache_hit'; entity: string; documents: number; chunks: number }
  | { type: 'ingesting'; entity: string }
  | { type: 'ingest_progress'; entity: string; event: { type: string; source?: string; count?: number; documentsAdded?: number; chunksAdded?: number } }
  | { type: 'ingest_complete'; entity: string; finalEventType: string }
  | { type: 'ingest_skipped'; entity: string; reason: string }
  | { type: 'ingest_truncated'; entity: string }
  | { type: 'retrieving'; topK: number }
  | { type: 'retrieved'; chunkCount: number }
  | { type: 'retrieval_error'; error: string }
  | { type: 'sources'; sources: ChatSource[] }
  | { type: 'thinking' }
  | { type: 'token'; text: string }
  | { type: 'usage'; input: number; output: number }
  | { type: 'done'; latencyMs: number }
  | { type: 'error'; error: string };

function ConversationView() {
  const params = useSearchParams();
  const initialQ = params.get('q') ?? '';

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef<string | null>(null);
  const idRef = useRef(0);

  const submit = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || streaming) return;

    const userId = ++idRef.current;
    const assistantId = ++idRef.current;
    const time = nowTimeString();
    const startedAt = Date.now();

    setTurns(prev => [
      ...prev,
      { id: userId, role: 'user', text: trimmed, time },
      {
        id: assistantId,
        role: 'assistant',
        activity: [],
        html: '',
        sources: [],
        time,
        latencyMs: 0,
        phase: 'streaming',
      },
    ]);
    setStreaming(true);

    const updateAssistant = (mut: (t: AssistantTurn) => AssistantTurn) => {
      setTurns(prev => prev.map(t => (t.id === assistantId && t.role === 'assistant' ? mut(t) : t)));
    };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      });
      if (!res.body) throw new Error('No response stream');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let event: ChatEvent;
          try { event = JSON.parse(line) as ChatEvent; } catch { continue; }
          handleEvent(event);
          if (event.type === 'done' || event.type === 'error' || event.type === 'clarification_needed') {
            finished = true;
            break;
          }
        }
      }
      reader.cancel().catch(() => { /* ignore */ });

      function handleEvent(event: ChatEvent) {
        const label = activityLabelFor(event);
        if (label) {
          updateAssistant(t => ({ ...t, activity: [...t.activity, label] }));
        }
        if (event.type === 'sources') {
          updateAssistant(t => ({ ...t, sources: event.sources }));
        }
        if (event.type === 'token') {
          updateAssistant(t => ({ ...t, html: t.html + event.text }));
        }
        if (event.type === 'clarification_needed') {
          updateAssistant(t => ({
            ...t,
            html: `<p><strong>Quick question to focus the answer:</strong> ${event.question}</p>`,
          }));
        }
        if (event.type === 'error') {
          updateAssistant(t => ({ ...t, error: event.error }));
        }
        if (event.type === 'done') {
          updateAssistant(t => ({ ...t, phase: 'done', latencyMs: event.latencyMs }));
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      updateAssistant(t => ({
        ...t,
        phase: 'done',
        error: message,
        latencyMs: Date.now() - startedAt,
      }));
    } finally {
      setStreaming(false);
    }
  };

  useEffect(() => {
    if (initialQ && seededRef.current !== initialQ) {
      seededRef.current = initialQ;
      void submit(initialQ);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQ]);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const handleSend = () => {
    void submit(input);
    setInput('');
  };

  const lastAssistant = [...turns].reverse().find((t): t is AssistantTurn => t.role === 'assistant');
  const headerContext = streaming
    ? 'Live retrieval · streaming'
    : lastAssistant
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
          <span className="accuracy">Sonnet 4.5 · Voyage · pgvector</span>
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
                  {turn.activity.length > 0 && <AgentActivity lines={turn.activity} />}
                  {(turn.html || turn.error) && (
                    <AssistantMessage
                      html={turn.error ? `<p style="color:#f87171"><strong>Error:</strong> ${escapeHtml(turn.error)}</p>` : turn.html}
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
                placeholder={streaming ? 'Streaming…' : 'Continue the conversation...'}
                value={input}
                disabled={streaming}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSend();
                }}
              />
              <button className="chat-send-btn" onClick={handleSend} disabled={streaming}>
                {streaming ? '…' : 'Send'}
              </button>
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
              <div key={a.name} className="agent-card">
                <span className="agent-name">{a.name}</span>
                <span className="agent-state">{a.model}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default function ConversationPage() {
  return (
    <Suspense fallback={<div className="ask-conversation-page" />}>
      <ConversationView />
    </Suspense>
  );
}
