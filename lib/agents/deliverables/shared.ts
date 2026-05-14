/**
 * Shared helpers for deliverable pipelines.
 * Common formatting, Sonnet JSON-output wrapper, HTML escape, etc.
 */

import { getAnthropic, SONNET_MODEL } from '@/lib/llm/anthropic';

export async function sonnetJson<T>(opts: {
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
}): Promise<T> {
  const client = getAnthropic();
  const response = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: opts.maxTokens ?? 2000,
    system: [{ type: 'text', text: opts.systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: opts.userMessage }],
  });
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('');
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error(`Sonnet returned non-JSON: ${cleaned.slice(0, 200)}`);
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

export function escape(s: string): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtPct(n: number, places = 1): string {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(places)}%`;
}

export function fmtPctRaw(n: number, places = 1): string {
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(places)}%`;
}

export function fmtMillions(n: number): string {
  if (!Number.isFinite(n) || n == null) return '—';
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}B`;
  return `$${Math.round(n).toLocaleString()}M`;
}

export function fmtMultiple(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(1)}x`;
}

export function fmtBps(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n)} bps`;
}

/** Build an HTML <table class="memo-table">. */
export function table(opts: {
  compact?: boolean;
  headers: string[];
  rows: Array<Array<string | { value: string; numeric?: boolean; strong?: boolean; highlight?: boolean }>>;
  numericColumns?: number[];   // 0-indexed columns that should be right-aligned
}): string {
  const cls = `memo-table${opts.compact ? ' memo-table-compact' : ''}`;
  const numericSet = new Set(opts.numericColumns ?? []);
  const headerRow = opts.headers
    .map((h, i) => `<th${numericSet.has(i) ? ' class="num"' : ''}>${escape(h)}</th>`)
    .join('');
  const bodyRows = opts.rows
    .map(row => {
      const tds = row
        .map((cell, i) => {
          if (typeof cell === 'string') {
            return `<td${numericSet.has(i) ? ' class="num"' : ''}>${escape(cell)}</td>`;
          }
          const classes: string[] = [];
          if (numericSet.has(i) || cell.numeric) classes.push('num');
          if (cell.highlight) classes.push('memo-cell-highlight');
          const inner = cell.strong ? `<strong>${escape(cell.value)}</strong>` : escape(cell.value);
          return `<td${classes.length ? ` class="${classes.join(' ')}"` : ''}>${inner}</td>`;
        })
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  return `<table class="${cls}"><thead><tr>${headerRow}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

export function section(heading: string): string {
  return `<h3 class="memo-h3">${escape(heading)}</h3>`;
}

export function note(html: string, kind: 'info' | 'warn' = 'info'): string {
  const style = kind === 'warn' ? ' style="border-left-color:#fbbf24"' : '';
  return `<p class="memo-data-note"${style}>${html}</p>`;
}

export function disclaimer(html: string): string {
  return `<p class="memo-disclaimer">${html}</p>`;
}

/** Origin of a value that fed a model. Used by every numerical pipeline to
 *  tag each input so the Work tab can show which numbers came from filings,
 *  which the user chose in the scope card, which fell back to a default, and
 *  which came from the LLM's training corpus (no live market feed). */
export type InputOrigin = 'sourced' | 'user_assumption' | 'model_knowledge' | 'default';

export interface InputTrace {
  field: string;          // pipeline-internal id, e.g. 'entry_ev', 'trailing_revenue'
  label: string;          // human label, e.g. 'Entry EV'
  value: string;          // pre-formatted display value, e.g. '$8.5B'
  origin: InputOrigin;
  sourceRef?: string;     // human-readable source pointer, e.g. 'SEC 10-K FY2024'
  citationN?: number;     // index into the deliverable's sources[] array, if applicable
}

/** A single line in a model's "show your work" — the math the user would
 *  re-derive if they wanted to audit the result. */
export interface CalcStep {
  step: string;     // human label, e.g. 'Entry EBITDA'
  expr: string;     // expression with the actual numbers, e.g. '$4.2B × 16.0%'
  value: string;    // resulting value, e.g. '$672M'
}

/** Generic deliverable event shape. */
export interface DeliverableEvent {
  type: 'progress' | 'token' | 'sources' | 'inputs_traced' | 'calc_steps' | 'done' | 'error';
  step?: string;
  text?: string;
  sources?: Array<{ n: number; title: string; url: string | null; meta: string }>;
  inputs?: InputTrace[];
  calc?: CalcStep[];
  error?: string;
}

/** Standard refusal banner used by every deliverable that pre-flights. */
export function refusalCard(opts: {
  deliverableLabel: string;          // e.g. "TRADING COMPS"
  target: string;
  headline: string;                  // short failure reason in bold banner
  detail: string;                    // 1-2 sentence explanation
  options?: string[];                // bullet list of revise/retry suggestions
  attempted?: string[];              // sources we tried, optional
  bannerColor?: 'amber' | 'red';
}): string {
  const color = opts.bannerColor === 'red' ? '#f87171' : '#fbbf24';
  const optionsHtml = opts.options && opts.options.length > 0
    ? `<p><strong>Options:</strong></p><ul class="memo-bullets">${opts.options.map(o => `<li>→ ${escape(o)}</li>`).join('')}</ul>`
    : '';
  const attemptedHtml = opts.attempted && opts.attempted.length > 0
    ? `<p class="memo-disclaimer">Sources attempted: ${opts.attempted.join(' → ')}.</p>`
    : '';
  return [
    `<div class="memo-rec-banner" style="border-left-color:${color}">
       <div class="memo-rec-label" style="color:${color}">CANNOT RUN ${escape(opts.deliverableLabel)}</div>
       <div class="memo-rec-headline">${escape(opts.target)}: ${escape(opts.headline)}</div>
     </div>`,
    `<p>${escape(opts.detail)}</p>`,
    optionsHtml,
    attemptedHtml,
    `<p class="memo-disclaimer">Compass refuses to fabricate. The output would look credible but the numbers and entities would be made up.</p>`,
  ].join('\n');
}
