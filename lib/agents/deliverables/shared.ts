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
  return parseSonnetJson<T>(text);
}

/**
 * Tolerantly extract a JSON object or array from a model response.
 *
 * Sonnet is told to emit STRICT JSON, but it occasionally appends a
 * trailing prose epilogue ("Note: I assumed …") or prefixes a leading
 * preamble. The old `firstBrace…lastBrace` substring scheme failed when
 * trailing prose contained any `}` character (the resulting slice ran
 * past the real JSON, and JSON.parse threw 'Unexpected non-whitespace
 * character after JSON at position N').
 *
 * Walk the string once, finding the first balanced `{...}` or `[...]`
 * block — respecting strings + escape sequences so braces inside string
 * literals don't throw the depth counter off. Returns the JSON-parsed
 * result. Used by every deliverable pipeline via sonnetJson().
 */
export function parseSonnetJson<T>(raw: string): T {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const block = extractFirstBalancedJson(cleaned);
  if (!block) {
    throw new Error(`Sonnet returned no parseable JSON block: ${cleaned.slice(0, 200)}`);
  }
  try {
    return JSON.parse(block) as T;
  } catch (err) {
    throw new Error(`Sonnet JSON.parse failed (${(err as Error).message}): ${block.slice(0, 200)}`);
  }
}

function extractFirstBalancedJson(s: string): string | null {
  // Find the first { or [ that opens a balanced block. We need to find
  // the FIRST viable opener — some prefaces include curlies inside prose
  // (rare, but possible), so attempt each candidate opener until one
  // produces a balanced parse-able block.
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '{' && c !== '[') continue;
    const end = findBalancedEnd(s, i);
    if (end > i) {
      const candidate = s.slice(i, end + 1);
      // Validate by parsing — if it fails (e.g. opener wasn't a real
      // JSON start), keep scanning for the next opener.
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // fall through to keep scanning
      }
    }
  }
  return null;
}

/**
 * Given an opening { or [ at index `start`, find the matching closer.
 * Tracks nested depth and respects string literals (so braces inside
 * strings don't affect the counter). Returns -1 if no balanced closer.
 */
function findBalancedEnd(s: string, start: number): number {
  const opener = s[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = false; }
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === opener) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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
  type: 'progress' | 'token' | 'sources' | 'inputs_traced' | 'inputs_resolved' | 'calc_steps' | 'done' | 'error';
  step?: string;
  text?: string;
  /** Source entries. `kind` and `runId` are optional — the citation audit
   *  infers kind from text when absent, and runId is only meaningful for
   *  prior_run citations (Monte Carlo, Excel export, etc.). */
  sources?: Array<{
    n: number;
    title: string;
    url: string | null;
    meta: string;
    kind?: 'primary_document' | 'model_corpus' | 'prior_run';
    runId?: string;
  }>;
  /** For inputs_traced this is an array of InputTrace; for inputs_resolved it's
   *  the underlying pure model's input object (used to thread base scalars
   *  through prior_context for Monte Carlo / Excel follow-ups). */
  inputs?: InputTrace[] | Record<string, unknown>;
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
