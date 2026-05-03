/**
 * IC Memo deliverable (HTML in chat).
 *
 * Renders the same six sections from the original PDF spec — recommendation
 * banner, executive summary, investment thesis, returns profile, risk
 * factors, diligence status — sourced from the indexed corpus + the user's
 * scope answers. Sections are generated in parallel by Sonnet.
 */

import { searchChunks } from '@/lib/retrieval/vector_search';
import { resolveEntity } from '@/lib/lookup/resolve';
import {
  type DeliverableEvent,
  escape,
  note,
  section,
  sonnetJson,
  table,
} from './shared';

export interface ICMemoScope {
  thesis_priority?: string;          // "growth" | "margin" | "defensibility"
  risk_emphasis?: string;            // "financial" | "market" | "ai_disruption"
  returns_depth?: string;
  comp_set_scope?: string;
  [k: string]: unknown;
}

interface ChunkContext {
  n: number;
  title: string;
  source: string;
  doc_type: string;
  filed_at: string | null;
  url: string | null;
  excerpt: string;
}

interface RecommendationOut {
  headline: string;
  conviction: 'High' | 'Medium' | 'Low';
}

interface ExecSummaryOut {
  paragraph: string;
}

interface ThesisOut {
  items: Array<{ headline: string; body: string }>;
}

interface ReturnsOut {
  stats: Array<{ label: string; value: string; note?: string }>;
  commentary: string;
}

interface RisksOut {
  items: Array<{ risk: string; severity: 'high' | 'medium' | 'low'; mitigation: string }>;
}

interface DiligenceOut {
  verified: string[];
  pending: string[];
}

const SHARED_VOICE = `Voice rules — strictly enforced:
- Formal banking voice. We recommend, We expect, Risks include, Returns are.
- Never "we think", "exciting", "amazing", or first-person color.
- Never use emoji.
- Tabular numbers: $520M (not $520 million); 15.4% (not "fifteen percent").
- Cite EVERY factual claim with [N] referring to the SOURCES list provided.
- If supporting evidence is missing for a claim, state the data gap explicitly. Never fabricate filings, prices, deal terms, quotes, or model outputs.
- Output STRICT JSON only — no markdown fences, no preamble, no trailing prose.`;

function formatSourcesForPrompt(chunks: ChunkContext[]): string {
  return chunks
    .map(c => {
      const date = c.filed_at ? c.filed_at.slice(0, 10) : 'unknown date';
      return `[${c.n}] ${c.title} — ${c.source} ${c.doc_type}, filed ${date}\n${c.excerpt}`;
    })
    .join('\n\n---\n\n');
}

async function genRecommendation(target: string, dealType: string, chunks: ChunkContext[], scope: ICMemoScope): Promise<RecommendationOut> {
  const systemPrompt = `Drafting the RECOMMENDATION banner for an Investment Committee memo.

${SHARED_VOICE}

Schema:
{
  "headline": "<1-2 sentence bold-banner-style recommendation. Specific. Action-oriented. Cite sources [N].>",
  "conviction": "<'High' | 'Medium' | 'Low'>"
}`;
  const user = `Target: ${target}
Deal type: ${dealType}
Thesis priority: ${scope.thesis_priority ?? 'growth'}

SOURCES:
${formatSourcesForPrompt(chunks)}`;
  return sonnetJson<RecommendationOut>({ systemPrompt, userMessage: user, maxTokens: 600 });
}

async function genExecSummary(target: string, dealType: string, chunks: ChunkContext[]): Promise<ExecSummaryOut> {
  const systemPrompt = `Drafting the EXECUTIVE SUMMARY for an IC memo.

${SHARED_VOICE}

Schema:
{ "paragraph": "<single paragraph, 3-4 sentences. State the recommendation, key thesis, and headline returns. Every claim cites [N].>" }`;
  const user = `Target: ${target}\nDeal type: ${dealType}\n\nSOURCES:\n${formatSourcesForPrompt(chunks)}`;
  return sonnetJson<ExecSummaryOut>({ systemPrompt, userMessage: user, maxTokens: 600 });
}

async function genThesis(target: string, dealType: string, chunks: ChunkContext[], scope: ICMemoScope): Promise<ThesisOut> {
  const systemPrompt = `Drafting the INVESTMENT THESIS for an IC memo.

${SHARED_VOICE}

Schema:
{
  "items": [{ "headline": "<5-9 word punchy headline>", "body": "<1-2 sentences with [N] inline citations>" }]
}

Output 4-6 items. Each headline tight, each body grounded in SOURCES.`;
  const user = `Target: ${target}\nDeal type: ${dealType}\nThesis priority: ${scope.thesis_priority ?? 'growth'}\n\nSOURCES:\n${formatSourcesForPrompt(chunks)}`;
  return sonnetJson<ThesisOut>({ systemPrompt, userMessage: user, maxTokens: 1500 });
}

async function genReturns(target: string, dealType: string, chunks: ChunkContext[]): Promise<ReturnsOut> {
  const systemPrompt = `Drafting the RETURNS PROFILE for an IC memo.

${SHARED_VOICE}

Schema:
{
  "stats": [{ "label": "<short>", "value": "<value with units>", "note": "<optional 1-line>" }],
  "commentary": "<2-3 sentences interpreting the returns picture. Cite [N].>"
}

Build 4-7 stats. Pull only from SOURCES — do not fabricate model outputs.`;
  const user = `Target: ${target}\nDeal type: ${dealType}\n\nSOURCES:\n${formatSourcesForPrompt(chunks)}`;
  return sonnetJson<ReturnsOut>({ systemPrompt, userMessage: user, maxTokens: 1200 });
}

async function genRisks(target: string, dealType: string, chunks: ChunkContext[], scope: ICMemoScope): Promise<RisksOut> {
  const systemPrompt = `Drafting RISK FACTORS for an IC memo.

${SHARED_VOICE}

Schema:
{
  "items": [{ "risk": "<one tight sentence>", "severity": "<'high' | 'medium' | 'low'>", "mitigation": "<one tight sentence>" }]
}

Output 3-5 items grounded in SOURCES (10-K risk factors, press, gaps). Each cites [N] when supported.`;
  const user = `Target: ${target}\nDeal type: ${dealType}\nRisk emphasis: ${scope.risk_emphasis ?? 'financial + market'}\n\nSOURCES:\n${formatSourcesForPrompt(chunks)}`;
  return sonnetJson<RisksOut>({ systemPrompt, userMessage: user, maxTokens: 1500 });
}

async function genDiligence(target: string, dealType: string, chunks: ChunkContext[]): Promise<DiligenceOut> {
  const systemPrompt = `Drafting DILIGENCE STATUS for an IC memo.

${SHARED_VOICE}

Schema:
{
  "verified": ["<short claim with [N]>", ...],
  "pending": ["<gap grounded in what SOURCES do NOT cover>", ...]
}

Output 3-5 verified + 2-4 pending items. Verified items must cite [N].`;
  const user = `Target: ${target}\nDeal type: ${dealType}\n\nSOURCES:\n${formatSourcesForPrompt(chunks)}`;
  return sonnetJson<DiligenceOut>({ systemPrompt, userMessage: user, maxTokens: 1200 });
}

export async function* runICMemoPipeline(opts: {
  query: string;
  scope: ICMemoScope;
  detectedTarget?: { name: string; ticker?: string } | null;
}): AsyncGenerator<DeliverableEvent, void> {
  const target = opts.detectedTarget?.name ?? opts.query;
  yield { type: 'progress', step: `Resolving target ${target}…` };

  const resolved = await resolveEntity(target);
  const targetName = resolved?.name ?? target;
  const dealType = inferDealType(opts.query, opts.scope);

  yield { type: 'progress', step: 'Pulling indexed sources from corpus…' };

  let chunks: ChunkContext[] = [];
  try {
    const retrieved = await searchChunks(opts.query, {
      topK: 12,
      targetIds: resolved ? [resolved.id] : undefined,
    });
    chunks = retrieved.map((c, i) => ({
      n: i + 1,
      title: c.documentTitle,
      source: c.documentSource,
      doc_type: c.documentType,
      filed_at: c.filedAt,
      url: c.documentUrl,
      excerpt: c.content.slice(0, 800),
    }));
  } catch (err) {
    yield { type: 'progress', step: `Retrieval skipped (${err instanceof Error ? err.message : 'error'})` };
  }

  if (chunks.length === 0) {
    yield {
      type: 'token',
      text: [
        `<p><strong>${escape(targetName)} IC Memo</strong></p>`,
        note(
          `<strong>Note:</strong> No indexed sources are available for ${escape(targetName)} yet. Drafting an IC memo without grounded citations would violate Compass's no-fabrication rule. Try ingesting the entity first (search for it in the chat — Compass auto-ingests on demand) and then re-run this memo request.`,
          'warn',
        ),
      ].join(''),
    };
    yield { type: 'done' };
    return;
  }

  yield { type: 'progress', step: `Drafting six sections in parallel against ${chunks.length} sources…` };

  const [recRes, esRes, thRes, retRes, riskRes, dilRes] = await Promise.allSettled([
    genRecommendation(targetName, dealType, chunks, opts.scope),
    genExecSummary(targetName, dealType, chunks),
    genThesis(targetName, dealType, chunks, opts.scope),
    genReturns(targetName, dealType, chunks),
    genRisks(targetName, dealType, chunks, opts.scope),
    genDiligence(targetName, dealType, chunks),
  ]);

  const rec = pickResult(recRes, { headline: 'Recommendation generation failed.', conviction: 'Low' as const });
  const es = pickResult(esRes, { paragraph: 'Executive summary unavailable.' });
  const th = pickResult(thRes, { items: [{ headline: 'Thesis unavailable', body: 'Section generation failed.' }] });
  const ret = pickResult(retRes, { stats: [], commentary: 'Returns profile unavailable.' });
  const risk = pickResult(riskRes, { items: [{ risk: 'Risk analysis unavailable.', severity: 'high' as const, mitigation: 'Section generation failed.' }] });
  const dil = pickResult(dilRes, { verified: [], pending: ['Diligence analysis unavailable.'] });

  yield { type: 'sources', sources: chunks.map(c => ({ n: c.n, title: c.title, url: c.url, meta: `${prettySource(c.source)} · ${c.doc_type} · ${c.filed_at?.slice(0, 10) ?? '—'}` })) };

  yield { type: 'progress', step: 'Rendering memo…' };
  yield { type: 'token', text: renderICMemoHtml(targetName, dealType, rec, es, th, ret, risk, dil, chunks) };
  yield { type: 'done' };
}

function pickResult<T>(r: PromiseSettledResult<T>, fallback: T): T {
  return r.status === 'fulfilled' ? r.value : fallback;
}

function inferDealType(query: string, scope: ICMemoScope): string {
  const q = query.toLowerCase();
  if (q.includes('ipo') || q.includes('s-1')) return 'IPO Investment';
  if (q.includes('lbo') || q.includes('take-private') || q.includes('buyout')) return 'Sponsor LBO';
  if (q.includes('m&a') || q.includes('acquisition') || q.includes('merger')) return 'M&A Investment';
  if (q.includes('bond') || q.includes('notes') || q.includes('debt')) return 'Debt Investment';
  if (typeof scope.deal_type === 'string') return scope.deal_type;
  return 'Investment';
}

function prettySource(source: string): string {
  if (source === 'sec_edgar') return 'SEC EDGAR';
  if (source === 'news_rss') return 'News';
  if (source === 'gdelt') return 'GDELT';
  if (source === 'fred') return 'FRED';
  return source;
}

/** Inline-citation rendering: turn [N] tokens into superscript styled links. */
function renderInline(text: string): string {
  return escape(text).replace(/\[(\d+)\]/g, (_m, n) => `<a class="chat-citation" href="#source-${n}">${n}</a>`);
}

function renderICMemoHtml(
  targetName: string,
  dealType: string,
  rec: RecommendationOut,
  es: ExecSummaryOut,
  th: ThesisOut,
  ret: ReturnsOut,
  risk: RisksOut,
  dil: DiligenceOut,
  chunks: ChunkContext[],
): string {
  const headline = `<p><strong>Investment Committee Memo · ${escape(targetName)} · ${escape(dealType)}</strong></p>`;

  const recBanner = `<div class="memo-rec-banner">
    <div class="memo-rec-label">RECOMMENDATION</div>
    <div class="memo-rec-headline">${renderInline(rec.headline)}</div>
    <div class="memo-rec-conviction">CONVICTION: ${escape(rec.conviction.toUpperCase())}</div>
  </div>`;

  const execSummary = `<p>${renderInline(es.paragraph)}</p>`;

  const thesisHtml = `<ol class="memo-numbered">${th.items
    .map(it => `<li><strong>${escape(it.headline)}.</strong> ${renderInline(it.body)}</li>`)
    .join('')}</ol>`;

  const returnsTable = ret.stats.length > 0
    ? table({
        headers: ['Metric', 'Value', 'Context'],
        rows: ret.stats.map(s => [s.label, s.value, s.note ?? '']),
        numericColumns: [1],
      })
    : '<p><em>No quantitative returns data available from indexed sources.</em></p>';

  const returnsCommentary = `<p>${renderInline(ret.commentary)}</p>`;

  const risksHtml = risk.items
    .map(
      r => `<div class="memo-risk-row">
        <span class="memo-risk-severity sev-${r.severity}">${r.severity.toUpperCase()}</span>
        <div class="memo-risk-body">
          <div>${renderInline(r.risk)}</div>
          <div class="memo-risk-mitigation"><em>Mitigation:</em> ${renderInline(r.mitigation)}</div>
        </div>
      </div>`,
    )
    .join('');

  const dilTable = `<div class="memo-two-col">
    <div>
      <div class="memo-col-header">VERIFIED</div>
      <ul class="memo-bullets">${dil.verified.map(v => `<li>✓ ${renderInline(v)}</li>`).join('')}</ul>
    </div>
    <div>
      <div class="memo-col-header">PENDING</div>
      <ul class="memo-bullets">${dil.pending.map(p => `<li>○ ${escape(p)}</li>`).join('')}</ul>
    </div>
  </div>`;

  const sourcesList = `<ol class="memo-citations">${chunks
    .map(
      c => `<li id="source-${c.n}">
        <strong>${escape(c.title)}</strong>
        <div class="memo-citation-meta">${escape(prettySource(c.source))} · ${escape(c.doc_type)} · ${escape(c.filed_at?.slice(0, 10) ?? 'undated')}</div>
        ${c.url ? `<a class="chat-source-link" href="${escape(c.url)}" target="_blank" rel="noreferrer">${escape(c.url.length > 90 ? c.url.slice(0, 90) + '…' : c.url)}</a>` : ''}
      </li>`,
    )
    .join('')}</ol>`;

  return [
    headline,
    recBanner,
    section('Executive Summary'),
    execSummary,
    section('Investment Thesis'),
    thesisHtml,
    section('Returns Profile'),
    returnsTable,
    returnsCommentary,
    section('Risk Factors'),
    risksHtml,
    section('Diligence Status'),
    dilTable,
    section('Sources & Citations'),
    sourcesList,
  ].join('\n');
}
