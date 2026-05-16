/**
 * Trading Comps deliverable.
 *
 * Two-pass design:
 *   1) Sonnet proposes a tight peer set (tickers + inclusion rationale).
 *   2) For target + each peer, we pull LTM revenue / operating income /
 *      gross profit DIRECTLY from SEC XBRL (computed from quarterly facts
 *      rolled forward against the prior FY). Peers whose latest filing is
 *      older than 180 days are dropped — that filter catches companies
 *      taken private (Alteryx), acquired (HashiCorp → IBM), or wound down.
 *   3) Sonnet then produces multiples (EV/Revenue, EV/EBITDA, P/E NTM) and
 *      a positioning narrative grounded in the REAL fundamentals.
 *
 * The fundamentals are now sourced — no longer "model-grounded estimates."
 * Market cap and EV still come from Sonnet's training corpus because we
 * have no live equity-price feed, and we say so in the data note.
 */

import {
  type DeliverableEvent,
  type InputTrace,
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
import { findByTicker } from '@/lib/lookup/sec_tickers';
import { getLtmFinancials, type LtmFinancials } from '@/lib/retrieval/xbrl_ltm';

export interface TradingCompsScope {
  num_comps?: number;
  comp_universe_scope?: string;       // 'sector_pure' | 'sector_plus' | 'broad'
  metrics_focus?: string[];
  precedent_window?: number;
  [k: string]: unknown;
}

interface PeerProposal {
  ticker: string;
  name: string;
  rationale: string;
}

interface PeerLtmFundamentals {
  ticker: string;
  name: string;
  cik: string;
  rationale: string;
  ltmRevenueM: number;
  ltmOperatingIncomeM: number | null;
  ltmGrossProfitM: number | null;
  ltmRevenueGrowthPct: number | null;
  latestFilingDate: string;
  periodEnd: string;
  latestForm: string;
}

interface SonnetMultiplesOut {
  target_multiples: {
    market_cap_m: number;
    ev_m: number;
    ev_revenue_x: number;
    ev_ebitda_x: number | null;
    pe_ntm: number | null;
  };
  peer_multiples: Array<{
    ticker: string;
    market_cap_m: number;
    ev_m: number;
    ev_revenue_x: number;
    ev_ebitda_x: number | null;
    pe_ntm: number | null;
  }>;
  median: { ev_revenue_x: number; ev_ebitda_x: number | null; pe_ntm: number | null };
  mean:   { ev_revenue_x: number; ev_ebitda_x: number | null; pe_ntm: number | null };
  positioning: string;
}

const PEER_SELECT_PROMPT = `You pick a tight, defensible peer set for a Trading Comps analysis.

Output STRICT JSON only:
{
  "peers": [
    { "ticker": "<exchange ticker>", "name": "<company name>", "rationale": "<short phrase explaining inclusion>" }
  ]
}

Rules:
- Pick CURRENTLY PUBLICLY TRADED, standalone companies only. Do NOT include:
  - Companies that have been acquired (e.g. Splunk by Cisco 2024, HashiCorp by IBM 2025)
  - Companies taken private (e.g. Alteryx by Clearlake 2024, Anaplan by Thoma Bravo 2022)
  - Companies in active wind-down or bankruptcy
- Pick the requested number of peers (default 8).
- Comp-universe scope tightness:
    sector_pure → strict pure-play peers (homogeneous business model)
    sector_plus → core + adjacent sub-sectors
    broad       → broader industry / alternative comparables
- Tickers must be the company's current primary listing (US exchanges preferred).
- Be specific in rationale ("similar PLG SaaS expansion motion", "pure-play observability"); never generic.`;

const MULTIPLES_PROMPT = `You produce trading multiples for a Trading Comps analysis given REAL LTM fundamentals.

The LTM revenue / operating income / gross profit values in the input are SOURCED from SEC XBRL filings and are NOT estimates. Use them as the denominator for every multiple. Your job is to estimate the NUMERATORS — market cap and enterprise value — from your training knowledge of equity prices and net debt.

Output STRICT JSON only:
{
  "target_multiples": {
    "market_cap_m": <number, $M>,
    "ev_m": <number, $M>,
    "ev_revenue_x": <ev_m / ltm_revenue_m>,
    "ev_ebitda_x": <ev_m / ltm_operating_income_m or null if negative>,
    "pe_ntm": <number or null>
  },
  "peer_multiples": [
    {
      "ticker": "<ticker>",
      "market_cap_m": <number>,
      "ev_m": <number>,
      "ev_revenue_x": <number>,
      "ev_ebitda_x": <number or null>,
      "pe_ntm": <number or null>
    }
  ],
  "median": { "ev_revenue_x": <n>, "ev_ebitda_x": <n or null>, "pe_ntm": <n or null> },
  "mean":   { "ev_revenue_x": <n>, "ev_ebitda_x": <n or null>, "pe_ntm": <n or null> },
  "positioning": "<2-3 sentence read on how the target prints against the peer set>"
}

Rules:
- Compute every multiple as ev_m / ltm_*_m using the LTM denominator provided. Do NOT substitute your own LTM estimate.
- For loss-making companies, set ev_ebitda_x and pe_ntm to null.
- Median/mean skip null entries cleanly (compute over the non-null observations only).
- Be realistic about market cap: anchor to recent (within last 12 months) public-equity values from your training corpus.`;

// Min days of filing recency to keep a peer in the comp set. Beyond this,
// the issuer has likely been delisted / acquired / taken private.
const FILING_RECENCY_DAYS = 180;
// Hard cap on peer count Sonnet can propose — guards against an over-eager
// "broad" universe that bursts XBRL requests to the SEC.
const MAX_PEERS = 12;

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

  const numComps = Math.min(opts.scope.num_comps ?? 8, MAX_PEERS);
  const numCompsUserSpecified = opts.scope.num_comps != null;
  const universeScope = opts.scope.comp_universe_scope ?? 'sector_plus';
  const universeUserSpecified = opts.scope.comp_universe_scope != null;
  const metricsList = Array.isArray(opts.scope.metrics_focus) ? opts.scope.metrics_focus : ['ev_revenue', 'ev_ebitda', 'pe'];
  const metricsUserSpecified = Array.isArray(opts.scope.metrics_focus) && opts.scope.metrics_focus.length > 0;
  const metrics = metricsList.join(', ');

  // ---------- Pass 1: Sonnet proposes the peer ticker list ----------
  yield { type: 'progress', step: `Selecting peer set for ${pre.entity.name}…` };
  const peerProposalMessage = `Target: ${pre.entity.name}${pre.entity.ticker ? ` (${pre.entity.ticker})` : ''}
Number of peers: ${numComps}
Comp universe scope: ${universeScope}
Original ask: ${opts.query}`;

  let peerProposal: { peers: PeerProposal[] };
  try {
    peerProposal = await sonnetJson<{ peers: PeerProposal[] }>({
      systemPrompt: PEER_SELECT_PROMPT,
      userMessage: peerProposalMessage,
      maxTokens: 1200,
    });
  } catch (err) {
    yield { type: 'error', error: err instanceof Error ? err.message : 'Peer selection failed' };
    yield { type: 'done' };
    return;
  }
  const proposedPeers = (peerProposal.peers ?? []).slice(0, MAX_PEERS);
  if (proposedPeers.length === 0) {
    yield { type: 'error', error: 'No peers could be selected for this target.' };
    yield { type: 'done' };
    return;
  }

  // ---------- Pass 2: Fetch real XBRL LTM for target + each peer ----------
  yield { type: 'progress', step: `Pulling LTM fundamentals from SEC XBRL for ${proposedPeers.length} peers…` };

  const targetLtm = pre.entity.cik ? await getLtmFinancialsSafe(pre.entity.cik) : null;

  const now = new Date();
  const recencyCutoff = new Date(now.getTime() - FILING_RECENCY_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const peerFundamentals: PeerLtmFundamentals[] = [];
  const droppedPeers: Array<{ ticker: string; name: string; reason: string }> = [];

  for (const p of proposedPeers) {
    const entry = await findByTicker(p.ticker.toUpperCase());
    if (!entry) {
      droppedPeers.push({ ticker: p.ticker, name: p.name, reason: 'ticker not found in SEC universe (delisted or non-US)' });
      continue;
    }
    const ltm = await getLtmFinancialsSafe(entry.cik);
    if (!ltm || ltm.ltmRevenue == null || !ltm.latestFilingDate) {
      droppedPeers.push({ ticker: p.ticker, name: entry.name, reason: 'no XBRL revenue facts available' });
      continue;
    }
    if (ltm.latestFilingDate < recencyCutoff) {
      droppedPeers.push({
        ticker: p.ticker,
        name: entry.name,
        reason: `most recent filing ${ltm.latestFilingDate} is older than ${FILING_RECENCY_DAYS} days — likely delisted / acquired`,
      });
      continue;
    }
    peerFundamentals.push({
      ticker: entry.ticker,
      name: entry.name,
      cik: entry.cik,
      rationale: p.rationale,
      ltmRevenueM: ltm.ltmRevenue,
      ltmOperatingIncomeM: ltm.ltmOperatingIncome,
      ltmGrossProfitM: ltm.ltmGrossProfit,
      ltmRevenueGrowthPct: ltm.ltmRevenueGrowthPct,
      latestFilingDate: ltm.latestFilingDate,
      periodEnd: ltm.periodEnd ?? '',
      latestForm: ltm.latestForm ?? '10-Q',
    });
  }

  if (peerFundamentals.length === 0) {
    yield { type: 'error', error: 'No peers passed the XBRL-recency filter. Try a broader comp universe.' };
    yield { type: 'done' };
    return;
  }

  // ---------- Sources + InputTrace ----------
  const sources: Array<{ n: number; title: string; url: string | null; meta: string }> = [];
  if (pre.entity.cik) {
    sources.push({
      n: sources.length + 1,
      title: `${pre.entity.name} SEC EDGAR XBRL company facts`,
      url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${pre.entity.cik.padStart(10, '0')}.json`,
      meta: `Target LTM fundamentals · most recent filing through ${targetLtm?.latestFilingDate ?? 'n/a'}`,
    });
  }
  for (const peer of peerFundamentals) {
    sources.push({
      n: sources.length + 1,
      title: `${peer.name} SEC EDGAR XBRL company facts`,
      url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${peer.cik.padStart(10, '0')}.json`,
      meta: `Peer LTM · period ending ${peer.periodEnd} · ${peer.latestForm} filed ${peer.latestFilingDate}`,
    });
  }
  const modelSourceN = sources.length + 1;
  sources.push({
    n: modelSourceN,
    title: 'Sonnet 4.5 training corpus',
    url: null,
    meta: 'Market cap + enterprise value · model-grounded, not live equity-price data',
  });
  yield { type: 'sources', sources };

  const inputs: InputTrace[] = [
    {
      field: 'target',
      label: 'Target entity',
      value: `${pre.entity.name}${pre.entity.ticker ? ` (${pre.entity.ticker})` : ''}`,
      origin: 'sourced',
      sourceRef: pre.hasFilings ? `SEC EDGAR · CIK ${pre.entity.cik}` : 'Curated entity registry',
      citationN: pre.entity.cik ? 1 : undefined,
    },
    {
      field: 'num_comps',
      label: 'Peers selected',
      value: `${peerFundamentals.length} (of ${proposedPeers.length} proposed)`,
      origin: numCompsUserSpecified ? 'user_assumption' : 'default',
      sourceRef: numCompsUserSpecified ? 'Scope card' : 'Manifest default (8)',
    },
    {
      field: 'comp_universe_scope',
      label: 'Comp universe scope',
      value: String(universeScope),
      origin: universeUserSpecified ? 'user_assumption' : 'default',
      sourceRef: universeUserSpecified ? 'Scope card' : 'Manifest default (sector_plus)',
    },
    {
      field: 'metrics_focus',
      label: 'Metrics in scope',
      value: metrics,
      origin: metricsUserSpecified ? 'user_assumption' : 'default',
      sourceRef: metricsUserSpecified ? 'Scope card' : 'Manifest default',
    },
    {
      field: 'peer_ltm',
      label: 'Peer LTM revenue / operating income / gross profit',
      value: `XBRL-sourced for ${peerFundamentals.length} peers; recency cutoff ${FILING_RECENCY_DAYS}d`,
      origin: 'sourced',
      sourceRef: 'SEC EDGAR XBRL company facts',
      citationN: pre.entity.cik ? 2 : 1,
    },
    {
      field: 'peer_multiples',
      label: 'Peer market cap + enterprise value',
      value: 'Sonnet estimate',
      origin: 'model_knowledge',
      sourceRef: 'Sonnet 4.5 training corpus — no live equity-price feed',
      citationN: modelSourceN,
    },
  ];
  yield { type: 'inputs_traced', inputs };

  // ---------- Pass 3: Sonnet computes multiples from real LTM ----------
  yield { type: 'progress', step: 'Computing multiples from real LTM fundamentals…' };
  const multiplesUserMessage = buildMultiplesPrompt({
    target: pre.entity.name,
    targetTicker: pre.entity.ticker,
    targetLtm,
    peers: peerFundamentals,
    metrics,
  });

  let multiples: SonnetMultiplesOut;
  try {
    multiples = await sonnetJson<SonnetMultiplesOut>({
      systemPrompt: MULTIPLES_PROMPT,
      userMessage: multiplesUserMessage,
      maxTokens: 3000,
    });
  } catch (err) {
    yield { type: 'error', error: err instanceof Error ? err.message : 'Multiples synthesis failed' };
    yield { type: 'done' };
    return;
  }

  yield { type: 'progress', step: 'Rendering deliverable…' };
  const html = renderTradingCompsHtml({
    targetName: pre.entity.name,
    targetTicker: pre.entity.ticker,
    targetSector: 'Software / SaaS',
    targetLtm,
    peerFundamentals,
    droppedPeers,
    multiples,
  });
  yield { type: 'token', text: html };
  yield { type: 'done' };
}

async function getLtmFinancialsSafe(cik: string): Promise<LtmFinancials | null> {
  try {
    return await getLtmFinancials(cik);
  } catch {
    return null;
  }
}

function buildMultiplesPrompt(args: {
  target: string;
  targetTicker?: string;
  targetLtm: LtmFinancials | null;
  peers: PeerLtmFundamentals[];
  metrics: string;
}): string {
  const lines: string[] = [];
  lines.push(`Target: ${args.target}${args.targetTicker ? ` (${args.targetTicker})` : ''}`);
  if (args.targetLtm?.ltmRevenue != null) {
    lines.push(`Target LTM revenue: $${args.targetLtm.ltmRevenue.toFixed(1)}M (period ending ${args.targetLtm.periodEnd})`);
    if (args.targetLtm.ltmOperatingIncome != null) {
      lines.push(`Target LTM operating income: $${args.targetLtm.ltmOperatingIncome.toFixed(1)}M`);
    }
    if (args.targetLtm.ltmGrossProfit != null) {
      lines.push(`Target LTM gross profit: $${args.targetLtm.ltmGrossProfit.toFixed(1)}M`);
    }
    if (args.targetLtm.ltmRevenueGrowthPct != null) {
      lines.push(`Target LTM YoY revenue growth: ${args.targetLtm.ltmRevenueGrowthPct.toFixed(1)}%`);
    }
  }
  lines.push('');
  lines.push('PEER FUNDAMENTALS (LTM, SEC XBRL, $M):');
  for (const p of args.peers) {
    const oi = p.ltmOperatingIncomeM != null ? `op_inc=$${p.ltmOperatingIncomeM.toFixed(1)}M` : 'op_inc=n/a';
    const gp = p.ltmGrossProfitM != null ? `gross=$${p.ltmGrossProfitM.toFixed(1)}M` : 'gross=n/a';
    const growth = p.ltmRevenueGrowthPct != null ? `growth=${p.ltmRevenueGrowthPct.toFixed(1)}%` : 'growth=n/a';
    lines.push(`- ${p.ticker} (${p.name}): rev=$${p.ltmRevenueM.toFixed(1)}M ${oi} ${gp} ${growth} period_end=${p.periodEnd} filed=${p.latestFilingDate}`);
  }
  lines.push('');
  lines.push(`Metric emphasis: ${args.metrics}`);
  lines.push('Estimate market cap + EV for each company. Compute multiples using the LTM denominators above (do not substitute your own).');
  return lines.join('\n');
}

interface RenderArgs {
  targetName: string;
  targetTicker?: string;
  targetSector: string;
  targetLtm: LtmFinancials | null;
  peerFundamentals: PeerLtmFundamentals[];
  droppedPeers: Array<{ ticker: string; name: string; reason: string }>;
  multiples: SonnetMultiplesOut;
}

function renderTradingCompsHtml(args: RenderArgs): string {
  const headline = `<p><strong>${escape(args.targetName)} Trading Comps · ${args.peerFundamentals.length} peers · ${escape(args.targetSector)}</strong></p>`;
  const positioning = `<p>${escape(args.multiples.positioning)}</p>`;

  const targetGrowth = args.targetLtm?.ltmRevenueGrowthPct;
  const targetMargin = args.targetLtm?.ltmRevenue && args.targetLtm.ltmOperatingIncome != null
    ? (args.targetLtm.ltmOperatingIncome / args.targetLtm.ltmRevenue) * 100
    : null;

  const targetRow = [
    { value: `${args.targetName}${args.targetTicker ? ` (${args.targetTicker})` : ''}`, strong: true },
    'TARGET',
    fmtMillions(args.targetLtm?.ltmRevenue ?? 0),
    targetGrowth != null ? fmtPctRaw(targetGrowth) : '—',
    targetMargin != null ? fmtPctRaw(targetMargin) : '—',
    fmtMultiple(args.multiples.target_multiples.ev_revenue_x),
    args.multiples.target_multiples.ev_ebitda_x != null
      ? fmtMultiple(args.multiples.target_multiples.ev_ebitda_x)
      : '—',
    args.multiples.target_multiples.pe_ntm != null
      ? fmtMultiple(args.multiples.target_multiples.pe_ntm)
      : '—',
  ];

  // Index peer multiples by ticker so we can join with the fundamentals.
  const multiplesByTicker = new Map(
    args.multiples.peer_multiples.map(m => [m.ticker.toUpperCase(), m]),
  );
  const peerRows = args.peerFundamentals.map(p => {
    const m = multiplesByTicker.get(p.ticker.toUpperCase());
    const margin = p.ltmOperatingIncomeM != null && p.ltmRevenueM > 0
      ? (p.ltmOperatingIncomeM / p.ltmRevenueM) * 100
      : null;
    return [
      p.name,
      p.ticker,
      fmtMillions(p.ltmRevenueM),
      p.ltmRevenueGrowthPct != null ? fmtPctRaw(p.ltmRevenueGrowthPct) : '—',
      margin != null ? fmtPctRaw(margin) : '—',
      m ? fmtMultiple(m.ev_revenue_x) : '—',
      m && m.ev_ebitda_x != null ? fmtMultiple(m.ev_ebitda_x) : '—',
      m && m.pe_ntm != null ? fmtMultiple(m.pe_ntm) : '—',
    ];
  });

  const medianRow = [
    { value: 'Median', strong: true },
    '',
    '',
    '',
    '',
    fmtMultiple(args.multiples.median.ev_revenue_x),
    args.multiples.median.ev_ebitda_x != null ? fmtMultiple(args.multiples.median.ev_ebitda_x) : '—',
    args.multiples.median.pe_ntm != null ? fmtMultiple(args.multiples.median.pe_ntm) : '—',
  ];
  const meanRow = [
    { value: 'Mean', strong: true },
    '',
    '',
    '',
    '',
    fmtMultiple(args.multiples.mean.ev_revenue_x),
    args.multiples.mean.ev_ebitda_x != null ? fmtMultiple(args.multiples.mean.ev_ebitda_x) : '—',
    args.multiples.mean.pe_ntm != null ? fmtMultiple(args.multiples.mean.pe_ntm) : '—',
  ];

  const compsTable = table({
    compact: true,
    headers: ['Company', 'Ticker', 'LTM Rev', 'Rev Growth', 'OI Margin', 'EV/Rev', 'EV/EBITDA', 'P/E NTM'],
    rows: [targetRow, ...peerRows, medianRow, meanRow],
    numericColumns: [2, 3, 4, 5, 6, 7],
  });

  const rationaleRows = args.peerFundamentals.map(p => [p.ticker, p.name, p.rationale, `${p.latestForm} filed ${p.latestFilingDate}`]);
  const rationaleTable = table({
    compact: true,
    headers: ['Ticker', 'Company', 'Inclusion Rationale', 'Latest Filing'],
    rows: rationaleRows,
  });

  const droppedNote = args.droppedPeers.length > 0
    ? `<strong>Dropped from comp set:</strong> ${args.droppedPeers
        .map(d => `${escape(d.ticker)} (${escape(d.name)}) — ${escape(d.reason)}`)
        .join('; ')}.`
    : 'All proposed peers passed the SEC-filing recency filter.';

  return [
    headline,
    positioning,
    note(`<strong>Data sources:</strong> LTM revenue, operating income, and gross profit are sourced directly from SEC XBRL company facts (computed as previous_FY + current_YTD − prior_year_YTD when a 10-Q is more recent than the last 10-K). Market cap and enterprise value are model estimates — no live equity-price feed is wired in. ${droppedNote}`),
    section('Comps Table'),
    compsTable,
    section('Peer Inclusion + Recency'),
    rationaleTable,
  ].join('\n');
}
