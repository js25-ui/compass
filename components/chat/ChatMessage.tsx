'use client';

import { useEffect, useRef } from 'react';
import { SourceCitations, type CitedSource } from './SourceCitations';

interface UserMessageProps {
  text: string;
  time: string;
}

export function UserMessage({ text, time }: UserMessageProps) {
  return (
    <div className="chat-msg chat-msg-user fade-in">
      <div className="chat-msg-meta">
        <span>You</span>
        <span>{time}</span>
      </div>
      <div className="chat-msg-content">{text}</div>
    </div>
  );
}

interface AssistantMessageProps {
  html: string;
  sources: CitedSource[];
  time: string;
  latencyMs: number;
  confidence?: { score: number };
  citationAccuracy?: { score: number };
}

export function AssistantMessage({ html, sources, time, latencyMs, confidence, citationAccuracy }: AssistantMessageProps) {
  const seconds = (latencyMs / 1000).toFixed(1);
  const contentRef = useRef<HTMLDivElement>(null);

  // Excel export buttons are injected via dangerouslySetInnerHTML. Wire up
  // their click handlers via a delegated listener on the bubble's content
  // wrapper — POST the encoded payload to /api/model/excel-export and
  // trigger a binary download from the response.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const handler = async (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const btn = target.closest('.excel-export-btn');
      if (!btn || !(btn instanceof HTMLButtonElement)) return;
      const dataUri = btn.dataset.payload;
      const filename = btn.dataset.filename ?? 'model.xlsx';
      if (!dataUri) return;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Generating…';
      try {
        const base64 = dataUri.split(',')[1] ?? '';
        const payload = atob(base64);
        const res = await fetch('/api/model/excel-export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        });
        if (!res.ok) {
          const errText = await res.text();
          let msg: string;
          try { msg = (JSON.parse(errText) as { error?: string }).error ?? errText; }
          catch { msg = errText; }
          btn.textContent = `Failed: ${msg.slice(0, 80)}`;
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        btn.textContent = '✓ Downloaded';
      } catch (err) {
        btn.textContent = `Failed: ${err instanceof Error ? err.message : 'unknown'}`;
      } finally {
        setTimeout(() => { if (original) btn.textContent = original; btn.disabled = false; }, 4000);
      }
    };
    el.addEventListener('click', handler);
    return () => el.removeEventListener('click', handler);
  }, [html]);

  return (
    <div className="chat-msg chat-msg-assistant fade-in">
      <div className="chat-msg-meta">
        <span>Compass</span>
        <span>
          {`${time} · ${seconds}s`}
          {confidence ? <span className={`conf-pill ${confTier(confidence.score)}`}>Conf {confidence.score}/100</span> : null}
          {citationAccuracy ? <span className={`cit-pill ${citTier(citationAccuracy.score)}`}>Citations {citationAccuracy.score}%</span> : null}
        </span>
      </div>
      <div ref={contentRef} className="chat-msg-content" dangerouslySetInnerHTML={{ __html: html }} />
      <SourceCitations sources={sources} />
    </div>
  );
}

function confTier(score: number): string {
  if (score >= 75) return 'conf-high';
  if (score >= 50) return 'conf-med';
  return 'conf-low';
}

function citTier(score: number): string {
  if (score >= 90) return 'conf-high';
  if (score >= 60) return 'conf-med';
  return 'conf-low';
}
