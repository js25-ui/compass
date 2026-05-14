/**
 * Trading Comps deliverable.
 *
 * Sonnet picks a peer set grounded in its training knowledge and produces a
 * structured comps table. We render with the standard memo-table and flag
 * everything as "model-estimated" since real-time market data isn't piped in.
 */

import {
  type DeliverableEvent,
  escape,
  fmtMillions,
  fmtMultiple,
  fmtPctRaw,
  note,
  refusalCard,
  section,
  sonnetJson,
  table,
} from './shared';
import { lightPreflight } from '@/lib/data/preflight';

export interface TradingCompsScope {
  num_comps?: number;
  comp_universe_scope?: string;       // 'sector_pure' | 'sector_plus' | 'broad'
  metrics_focus?: string[];
  precedent_window?: number;
  // accept anything else the clarify step put on it
  [k: string]: unknown;
}

interface CompRow {
  name: string;
  ticker: string;
  market_cap_m: number;
  ev_m: number;
  ltm_revenue_m: number;
  ltm_revenue_growth_pct: number;
  ltm_ebitda_margin_pct: number;
  ev_revenue_x: number;
  ev_ebitda_x: number;
  pe_ntm: number | null;
  rationale: string;
}

interface SonnetOut {
  target_summary: {
    name: string;
    ticker?: string;
    sector: string;
    ltm_revenue_m: number;
    ltm_revenue_growth_pct: number;
    ltm_ebitda_margin_pct: number;
    ev_revenue_x: number;
    ev_ebitda_x: number;
    pe_ntm: number | null;
  };
  peers: CompRow[];
  median: { ev_revenue_x: number; ev_ebitda_x: number; pe_ntm: number | null; revenue_growth_pct: number; ebitda_margin_pct: number };
  mean: { ev_revenue_x: number; ev_ebitda_x: number; pe_ntm: number | null; revenue_growth_pct: number; ebitda_margin_pct: number };
  positioning: string;
  data_caveats: string;
}

const SYSTEM_PROMPT = `You build a Trading Comps table for a capital-markets analyst.

Use your training knowledge to pick a tight peer set and ground multiples and metrics in the most recent figures you know. Every number in your output should be plausibly aligned with the company's last reported quarter or fiscal year. Do not invent companies; pick real, publicly-traded peers.

Output STRICT JSON only:

{
  "target_summary": {
    "name": "<canonical name>",
    "ticker": "<ticker if public>",
    "sector": "<short sector label>",
    "ltm_revenue_m": <number, $M>,
    "ltm_revenue_growth_pct": <number, e.g. 18.5>,
    "ltm_ebitda_margin_pct": <number>,
    "ev_revenue_x": <number>,
    "ev_ebitda_x": <number>,
    "pe_ntm": <number or null>
  },
  "peers": [
    {
      "name": "<name>",
      "ticker": "<ticker>",
      "market_cap_m": <number, $M>,
      "ev_m": <number, $M>,
      "ltm_revenue_m": <number>,
      "ltm_revenue_growth_pct": <number>,
      "ltm_ebitda_margin_pct": <number>,
      "ev_revenue_x": <number>,
      "ev_ebitda_x": <number>,
      "pe_ntm": <number or null>,
      "rationale": "<one short phrase explaining inclusion>"
    }
  ],
  "median": { "ev_revenue_x": <n>, "ev_ebitda_x": <n>, "pe_ntm": <n or null>, "revenue_growth_pct": <n>, "ebitda_margin_pct": <n> },
  "mean":   { "ev_revenue_x": <n>, "ev_ebitda_x": <n>, "pe_ntm": <n or null>, "revenue_growth_pct": <n>, "ebitda_margin_pct": <n> },
  "positioning": "<2-3 sentence read on where the target prints vs. the comp set on the metrics that matter>",
  "data_caveats": "<one sentence on what's stale or missing>"
}

Rules:
- Pick the requested number of peers (or 8 if not specified).
- Comp universe scope tightness:
    sector_pure → strict pure-play peers (smallest set, most homogeneous)
    sector_plus → core + adjacent sub-sectors
    broad       → broader industry / alternative comparables
- For loss-making companies, set pe_ntm=null. For private companies in the comp set, set pe_ntm=null and use estimated EV.
- ev_ebitda_x for negative-EBITDA companies should be null in the row — but the median/mean must skip nulls cleanly (only across positive observations).
- Be specific in rationale ("similar GPU/AI infrastructure exposure", "pure-play fast-casual", etc.) — never generic.`;

export async function* runTradingCompsPipeline(opts: {
  query: string;
  scope: TradingCompsScope;
  detectedTarget?: { name: string; ticker?: string } | null;
}): AsyncGenerator<DeliverableEvent, void> {
  const target = opts.detectedTarget?.name ?? opts.query;

  yield { type: 'progress', step: `Pre-flight: resolving ${target}…` };
  const pre = await lightPreflight({ query: opts.query, detectedTarget: opts.detectedTarget });
  if (!pre.ok) {
    yield {
      type: 'token',
      text: refusalCard({
        deliverableLabel: 'TRADING COMPS',
        target,
        headline: 'target not found',
        detail: pre.detail,
        options: [
          'Try a public-company ticker or full name (e.g. "Snowflake", "SNOW").',
          'For a sector-level read without a specific anchor, ask "what\'s new in [sector]" instead.',
        ],
      }),
    };
    yield { type: 'done' };
    return;
  }

  yield { type: 'progress', step: `Selecting peer set for ${pre.entity.name}…` };

  const numComps = opts.scope.num_comps ?? 8;
  const scope = opts.scope.comp_universe_scope ?? 'sector_plus';
  const metrics = Array.isArray(opts.scope.metrics_focus) ? opts.scope.metrics_focus.join(', ') : 'valuation, growth, profitability';

  const filingsNote = pre.hasFilings
    ? `${pre.entity.name} is an SEC filer (CIK ${pre.entity.cik}); cite filings only when supported.`
    : `${pre.entity.name} is NOT an SEC filer (private / sovereign / muni). Do NOT reference 10-K / 10-Q numbers — only public commentary, prospectus filings, or news. Mark target multiples as estimates.`;

  const userMessage = `Target: ${pre.entity.name}${pre.entity.ticker ? ` (${pre.entity.ticker})` : ''}
${filingsNote}
Number of peers: ${numComps}
Comp universe scope: ${scope}
Metric emphasis: ${metrics}
Original ask: ${opts.query}`;

  yield { type: 'progress', step: 'Gathering multiples and growth metrics…' };

  let parsed: SonnetOut;
  try {
    parsed = await sonnetJson<SonnetOut>({ systemPrompt: SYSTEM_PROMPT, userMessage, maxTokens: 3000 });
  } catch (err) {
    yield { type: 'error', error: err instanceof Error ? err.message : 'Trading comps generation failed' };
    yield { type: 'done' };
    return;
  }

  yield { type: 'progress', step: 'Rendering deliverable…' };
  const html = renderTradingCompsHtml(target, parsed);
  yield { type: 'token', text: html };
  yield { type: 'done' };
}

function renderTradingCompsHtml(targetName: string, out: SonnetOut): string {
  const headline = `<p><strong>${escape(targetName)} Trading Comps · ${out.peers.length} peers · ${escape(out.target_summary.sector)}</strong></p>`;

  const positioning = `<p>${escape(out.positioning)}</p>`;

  const targetRow = [
    { value: `${out.target_summary.name}${out.target_summary.ticker ? ` (${out.target_summary.ticker})` : ''}`, strong: true },
    'TARGET',
    fmtMillions(out.target_summary.ltm_revenue_m),
    fmtPctRaw(out.target_summary.ltm_revenue_growth_pct),
    fmtPctRaw(out.target_summary.ltm_ebitda_margin_pct),
    fmtMultiple(out.target_summary.ev_revenue_x),
    out.target_summary.ev_ebitda_x ? fmtMultiple(out.target_summary.ev_ebitda_x) : '—',
    out.target_summary.pe_ntm ? fmtMultiple(out.target_summary.pe_ntm) : '—',
  ];

  const peerRows = out.peers.map(p => [
    p.name,
    p.ticker,
    fmtMillions(p.ltm_revenue_m),
    fmtPctRaw(p.ltm_revenue_growth_pct),
    fmtPctRaw(p.ltm_ebitda_margin_pct),
    fmtMultiple(p.ev_revenue_x),
    p.ev_ebitda_x ? fmtMultiple(p.ev_ebitda_x) : '—',
    p.pe_ntm ? fmtMultiple(p.pe_ntm) : '—',
  ]);

  const medianRow = [
    { value: 'Median', strong: true },
    '',
    '',
    fmtPctRaw(out.median.revenue_growth_pct),
    fmtPctRaw(out.median.ebitda_margin_pct),
    fmtMultiple(out.median.ev_revenue_x),
    out.median.ev_ebitda_x ? fmtMultiple(out.median.ev_ebitda_x) : '—',
    out.median.pe_ntm ? fmtMultiple(out.median.pe_ntm) : '—',
  ];

  const meanRow = [
    { value: 'Mean', strong: true },
    '',
    '',
    fmtPctRaw(out.mean.revenue_growth_pct),
    fmtPctRaw(out.mean.ebitda_margin_pct),
    fmtMultiple(out.mean.ev_revenue_x),
    out.mean.ev_ebitda_x ? fmtMultiple(out.mean.ev_ebitda_x) : '—',
    out.mean.pe_ntm ? fmtMultiple(out.mean.pe_ntm) : '—',
  ];

  const compsTable = table({
    compact: true,
    headers: ['Company', 'Ticker', 'LTM Rev', 'Rev Growth', 'EBITDA Mgn', 'EV/Rev', 'EV/EBITDA', 'P/E NTM'],
    rows: [targetRow, ...peerRows, medianRow, meanRow],
    numericColumns: [2, 3, 4, 5, 6, 7],
  });

  const rationaleRows = out.peers.map(p => [p.ticker, p.name, p.rationale]);
  const rationaleTable = table({
    compact: true,
    headers: ['Ticker', 'Company', 'Inclusion Rationale'],
    rows: rationaleRows,
  });

  return [
    headline,
    positioning,
    note(`<strong>Data note:</strong> ${escape(out.data_caveats)} Multiples are model-grounded estimates aligned to last reported quarter / fiscal year. Live market data is not currently piped into Compass.`),
    section('Comps Table'),
    compsTable,
    section('Peer Inclusion Rationale'),
    rationaleTable,
  ].join('\n');
}
