'use client';

import { useSyncExternalStore } from 'react';
import Link from 'next/link';

export interface WorkTrace {
  turnId: number;
  startedAt: number;
  finishedAt: number | null;
  query: string;
  taskType: string | null;
  detectedTarget: { name: string; ticker?: string } | null;
  scope: Record<string, string | number | boolean | string[]>;
  activity: Array<{ t: number; type: string; label: string; detail?: string }>;
  sources: Array<{ n: number; title: string; url: string | null; source: string; docType: string; filedAt: string | null }>;
  inputs?: Array<{ field: string; label?: string; value: string; origin: 'sourced' | 'user_assumption' | 'model_knowledge' | 'default'; sourceRef?: string; citationN?: number }>;
  calc?: Array<{ step: string; expr: string; value: string }>;
  confidence?: { score: number; breakdown: Array<{ factor: string; weight: number; value: number; note: string }> };
  citationAccuracy?: { score: number; verified: number; checked: number; failures: Array<{ n: number; reason: string }> };
  error?: string;
}

const STORAGE_KEY = 'compass:lastWorkTrace';

function subscribeToTrace(callback: () => void): () => void {
  const handler = (e: StorageEvent) => { if (e.key === STORAGE_KEY) callback(); };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

function readTrace(): WorkTrace | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as WorkTrace) : null;
  } catch {
    return null;
  }
}

export default function WorkPage() {
  // useSyncExternalStore is the React-correct way to read from a non-React
  // store (localStorage). The third argument is the SSR snapshot — null
  // because there is no trace until the client mounts.
  const trace = useSyncExternalStore(subscribeToTrace, readTrace, () => null);

  if (!trace) {
    return (
      <div className="work-page">
        <div className="work-empty">
          <div className="work-empty-eyebrow">Audit Trail</div>
          <h1>No deliverable yet.</h1>
          <p>
            Run a deliverable from the <Link href="/chat" className="work-link">Chat tab</Link>. Every retrieval step,
            every agent action, every calculation, and every input-to-source trace will appear here.
          </p>
        </div>
      </div>
    );
  }

  // finishedAt is always set when writeWorkTrace persists; default to 0 if a
  // legacy/partial trace lacks it rather than calling Date.now() at render.
  const duration = trace.finishedAt ? trace.finishedAt - trace.startedAt : 0;
  const taskLabel = trace.taskType ? trace.taskType.replace(/_/g, ' ') : 'chat';
  const targetLabel = trace.detectedTarget
    ? `${trace.detectedTarget.name}${trace.detectedTarget.ticker ? ` (${trace.detectedTarget.ticker})` : ''}`
    : '—';

  return (
    <div className="work-page">
      <header className="work-header">
        <div className="work-header-row">
          <div>
            <div className="work-eyebrow">Audit Trail · Latest Deliverable</div>
            <h1 className="work-title">{taskLabel.toUpperCase()} · {targetLabel}</h1>
          </div>
          <div className="work-header-stats">
            <Stat label="Wall clock" value={`${(duration / 1000).toFixed(1)}s`} />
            <Stat label="Events" value={String(trace.activity.length)} />
            <Stat label="Sources" value={String(trace.sources.length)} />
            {trace.confidence ? <Stat label="Confidence" value={`${trace.confidence.score}/100`} /> : null}
            {trace.citationAccuracy ? <Stat label="Cit. accuracy" value={`${trace.citationAccuracy.score}%`} /> : null}
          </div>
        </div>
        <div className="work-query">
          <span className="work-query-label">User query →</span>
          <span className="work-query-text">{trace.query}</span>
        </div>
      </header>

      {trace.error ? (
        <Section title="Error">
          <pre className="work-error">{trace.error}</pre>
        </Section>
      ) : null}

      <Section title="Inputs traced to source">
        {trace.inputs && trace.inputs.length > 0 ? (
          <table className="work-table">
            <thead><tr><th>Field</th><th>Value</th><th>Origin</th><th>Source</th></tr></thead>
            <tbody>
              {trace.inputs.map((inp, i) => (
                <tr key={i}>
                  <td className="work-td-strong">{inp.label ?? inp.field}</td>
                  <td>{inp.value}</td>
                  <td>
                    <span className={`origin-pill origin-${inp.origin}`}>
                      {inp.origin === 'sourced' ? 'sourced'
                        : inp.origin === 'user_assumption' ? 'user assumption'
                        : inp.origin === 'model_knowledge' ? 'model knowledge'
                        : 'default'}
                    </span>
                  </td>
                  <td className="work-td-muted">
                    {inp.sourceRef ?? '—'}
                    {inp.citationN ? <span className="cit-ref"> [{inp.citationN}]</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="work-empty-block">No input-trace published for this run. Pipelines emit this in Tier 2.</p>
        )}
      </Section>

      <Section title="Calculation steps">
        {trace.calc && trace.calc.length > 0 ? (
          <table className="work-table">
            <thead><tr><th>Step</th><th>Expression</th><th>Value</th></tr></thead>
            <tbody>
              {trace.calc.map((c, i) => (
                <tr key={i}>
                  <td className="work-td-strong">{c.step}</td>
                  <td><code className="work-code">{c.expr}</code></td>
                  <td className="work-td-num">{c.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="work-empty-block">No calculation steps published. LLM-only deliverables (trading comps, precedents) have no numeric steps.</p>
        )}
      </Section>

      <Section title="Retrieval &amp; agent activity">
        <ol className="work-activity">
          {trace.activity.map((a, i) => (
            <li key={i}>
              <span className="work-activity-t">+{((a.t - trace.startedAt) / 1000).toFixed(2)}s</span>
              <span className={`work-activity-kind kind-${a.type}`}>{a.type}</span>
              <span className="work-activity-label">{a.label}</span>
              {a.detail ? <div className="work-activity-detail">{a.detail}</div> : null}
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Sources">
        {trace.sources.length === 0 ? (
          <p className="work-empty-block">No sources emitted by this deliverable.</p>
        ) : (
          <table className="work-table">
            <thead><tr><th>#</th><th>Title</th><th>Source</th><th>Type</th><th>Filed</th></tr></thead>
            <tbody>
              {trace.sources.map(s => (
                <tr key={s.n}>
                  <td className="work-td-num">[{s.n}]</td>
                  <td>{s.url ? <a className="work-link" href={s.url} target="_blank" rel="noreferrer">{s.title}</a> : s.title}</td>
                  <td className="work-td-muted">{s.source}</td>
                  <td className="work-td-muted">{s.docType}</td>
                  <td className="work-td-muted">{s.filedAt ? s.filedAt.slice(0, 10) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {trace.confidence ? (
        <Section title="Confidence breakdown">
          <table className="work-table">
            <thead><tr><th>Factor</th><th>Weight</th><th>Value</th><th>Note</th></tr></thead>
            <tbody>
              {trace.confidence.breakdown.map((b, i) => (
                <tr key={i}>
                  <td className="work-td-strong">{b.factor}</td>
                  <td className="work-td-num">{(b.weight * 100).toFixed(0)}%</td>
                  <td className="work-td-num">{(b.value * 100).toFixed(0)}/100</td>
                  <td className="work-td-muted">{b.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}

      {trace.citationAccuracy ? (
        <Section title="Citation accuracy verification">
          <p className="work-cit-summary">
            Verified <strong>{trace.citationAccuracy.verified}</strong> of <strong>{trace.citationAccuracy.checked}</strong> citations
            against actual source content → <strong>{trace.citationAccuracy.score}%</strong> accuracy.
          </p>
          {trace.citationAccuracy.failures.length > 0 ? (
            <table className="work-table">
              <thead><tr><th>Citation</th><th>Failure reason</th></tr></thead>
              <tbody>
                {trace.citationAccuracy.failures.map((f, i) => (
                  <tr key={i}>
                    <td className="work-td-num">[{f.n}]</td>
                    <td className="work-td-muted">{f.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="work-stat">
      <div className="work-stat-label">{label}</div>
      <div className="work-stat-value">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="work-section">
      <h2 className="work-section-title">{title}</h2>
      <div className="work-section-body">{children}</div>
    </section>
  );
}
