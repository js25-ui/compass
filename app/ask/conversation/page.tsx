'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { UserMessage, AssistantMessage } from '@/components/chat/ChatMessage';
import { AgentActivity } from '@/components/chat/AgentActivity';
import { ClarificationCard, type ClarificationPayload } from '@/components/chat/ClarificationCard';
import type { ClarifyQuestion } from '@/lib/agents/clarify';

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
  clarification?: ClarificationPayload & {
    originalQuery: string;
    acknowledgedScope: Record<string, string | number | boolean | string[]>;
    resolved?: boolean;
  };
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
    case 'clarifying': return 'Scoping the engagement…';
    case 'classified': {
      const t = event.detected_target;
      const target = t ? `${t.name}${t.ticker ? ` (${t.ticker})` : ''}` : '';
      return `Classified: ${event.task_type.replace(/_/g, ' ')}${target ? ` · ${target}` : ''}`;
    }
    case 'thinking': return 'Compass · thinking';
    case 'tool_call': return formatToolCall(event.name, event.input);
    case 'tool_result': return event.summary;
    case 'sources': {
      if (event.sources.length === 0) return null;
      const counts = countBySource(event.sources);
      const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`);
      return `Citing ${event.sources.length} sources (${parts.join(', ')})`;
    }
    default: return null;
  }
}

function formatToolCall(name: string, input: Record<string, unknown>): string {
  if (name === 'search_corpus') {
    const q = String(input.query ?? '').slice(0, 80);
    return `→ search_corpus("${q}")`;
  }
  if (name === 'list_indexed_entities') return '→ list_indexed_entities()';
  if (name === 'list_recent_corpus') {
    const days = input.days_back ?? 30;
    return `→ list_recent_corpus(${days}d)`;
  }
  if (name === 'ingest_entity') {
    return `→ ingest_entity("${String(input.entity ?? '')}")`;
  }
  return `→ ${name}(${JSON.stringify(input).slice(0, 60)})`;
}

function countBySource(sources: ChatSource[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sources) {
    const label = prettySourceShort(s.source, s.docType);
    out[label] = (out[label] ?? 0) + 1;
  }
  return out;
}

function prettySourceShort(source: string, docType: string): string {
  if (source === 'sec_edgar') return docType.includes('xbrl') ? 'XBRL facts' : 'SEC filings';
  if (source === 'news_rss') return 'news articles';
  if (source === 'gdelt') return 'GDELT articles';
  if (source === 'fred') return 'macro series';
  return source;
}

type ChatEvent =
  | { type: 'started'; query: string }
  | { type: 'clarifying' }
  | {
      type: 'clarification';
      task_type: string;
      asset_class: string;
      detected_target: { name: string; ticker?: string } | null;
      preface: string;
      questions: ClarifyQuestion[];
      acknowledged_scope?: Record<string, string | number | boolean | string[]>;
      acknowledged_pills?: Array<{ paramId: string; label: string; source: 'current_prompt' | 'conversation_history' | 'standing_preference' | 'inferred' }>;
    }
  | { type: 'classified'; task_type: string; asset_class: string; detected_target: { name: string; ticker?: string } | null }
  | { type: 'thinking' }
  | { type: 'tool_call'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; summary: string }
  | { type: 'sources'; sources: ChatSource[] }
  | { type: 'token'; text: string }
  | { type: 'usage'; input: number; output: number }
  | { type: 'done'; latencyMs: number; turns?: number }
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

  interface SubmitOpts {
    question: string;
    scope?: Record<string, string | number | boolean | string[]>;
    taskType?: string;
    detectedTarget?: { name: string; ticker?: string } | null;
    showAsUserTurn?: boolean;     // false when re-submitting after clarification
  }

  const submit = async (opts: SubmitOpts) => {
    const trimmed = opts.question.trim();
    if (!trimmed || streaming) return;

    const time = nowTimeString();
    const startedAt = Date.now();
    const assistantId = ++idRef.current;

    setTurns(prev => {
      const next = [...prev];
      if (opts.showAsUserTurn !== false) {
        next.push({ id: ++idRef.current, role: 'user', text: trimmed, time });
      }
      next.push({
        id: assistantId,
        role: 'assistant',
        activity: [],
        html: '',
        sources: [],
        time,
        latencyMs: 0,
        phase: 'streaming',
      });
      return next;
    });
    setStreaming(true);

    const updateAssistant = (mut: (t: AssistantTurn) => AssistantTurn) => {
      setTurns(prev => prev.map(t => (t.id === assistantId && t.role === 'assistant' ? mut(t) : t)));
    };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: trimmed,
          ...(opts.scope ? { scope: opts.scope } : {}),
          ...(opts.taskType ? { task_type: opts.taskType } : {}),
          ...(opts.detectedTarget ? { detected_target: opts.detectedTarget } : {}),
        }),
      });
      if (!res.body) throw new Error('No response stream');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      let sawDone = false;
      let sawClarification = false;
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
          if (event.type === 'done') sawDone = true;
          if (event.type === 'clarification') sawClarification = true;
          if (event.type === 'done' || event.type === 'error') {
            finished = true;
            break;
          }
        }
      }
      reader.cancel().catch(() => { /* ignore */ });

      // Stream ended without a 'done' or proper answer? Surface that.
      if (!sawDone && !sawClarification) {
        updateAssistant(t => {
          if (t.html || t.error) return t;
          return {
            ...t,
            phase: 'done',
            error: 'The response was cut off before completing. The query may have hit the function timeout. Try a more focused question or break it into steps.',
            latencyMs: Date.now() - startedAt,
          };
        });
      }

      function handleEvent(event: ChatEvent) {
        const label = activityLabelFor(event);
        if (label) {
          updateAssistant(t => ({ ...t, activity: [...t.activity, label] }));
        }
        if (event.type === 'clarification') {
          updateAssistant(t => ({
            ...t,
            phase: 'done',
            latencyMs: Date.now() - startedAt,
            clarification: {
              taskType: event.task_type,
              assetClass: event.asset_class,
              detectedTarget: event.detected_target,
              preface: event.preface,
              questions: event.questions,
              acknowledgedPills: event.acknowledged_pills,
              acknowledgedScope: event.acknowledged_scope ?? {},
              originalQuery: trimmed,
              resolved: false,
            },
          }));
        }
        if (event.type === 'sources') {
          updateAssistant(t => ({ ...t, sources: event.sources }));
        }
        if (event.type === 'token') {
          updateAssistant(t => ({ ...t, html: t.html + event.text }));
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
      void submit({ question: initialQ });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQ]);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const handleSend = () => {
    void submit({ question: input });
    setInput('');
  };

  const handleClarifyAnswer = (
    turnId: number,
    answers: Record<string, string | number | boolean | string[]>,
  ) => {
    const turn = turns.find(t => t.id === turnId);
    if (!turn || turn.role !== 'assistant' || !turn.clarification) return;
    setTurns(prev =>
      prev.map(t =>
        t.id === turnId && t.role === 'assistant' && t.clarification
          ? { ...t, clarification: { ...t.clarification, resolved: true } }
          : t,
      ),
    );
    // Merge previously-extracted scope with the user's new form answers.
    // New form answers take precedence (user revising what was extracted).
    const mergedScope = { ...turn.clarification.acknowledgedScope, ...answers };
    void submit({
      question: turn.clarification.originalQuery,
      scope: mergedScope,
      taskType: turn.clarification.taskType,
      detectedTarget: turn.clarification.detectedTarget,
      showAsUserTurn: false,
    });
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
                  {turn.clarification && !turn.clarification.resolved && (
                    <ClarificationCard
                      payload={turn.clarification}
                      disabled={streaming}
                      onSubmit={answers => handleClarifyAnswer(turn.id, answers)}
                    />
                  )}
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
