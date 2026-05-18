/**
 * Trading Comps deliverable.
 *
 * Three-pass design:
 *   1) Sonnet proposes a CANDIDATE peer list ~50% larger than the requested
 *      count, so the recency filter has slack to drop delisted / acquired
 *      issuers without falling below the target count.
 *   2) For target + each candidate, we pull LTM revenue / op income /
 *      gross profit / D&A / SBC DIRECTLY from SEC XBRL. Candidates whose
 *      latest filing is older than 180 days are dropped (catches Alteryx,
 *      HashiCorp, etc.). We trim the survivors back to the requested count.
 *   3) Sonnet produces multiples (market cap, EV, NTM revenue and EBITDA
 *      estimates) grounded in the REAL LTM fundamentals. EV/EBITDA uses
 *      Adjusted EBITDA (= Op Income + D&A + SBC) since that's the
 *      SaaS-comps standard. Operating-income-only EBITDA would understate
 *      every cloud peer by 30+ points and make the table meaningless.
 *
 * Fundamentals are sourced. Market cap, EV, and NTM estimates are model-
 * grounded — no live equity-price or consensus-estimates feed wired in.
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
import { findCikByTickerViaEdgarSearch } from '@/lib/lookup/edgar_search';
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
  ltmDaM: number | null;
  ltmSbcM: number | null;
  ltmEbitdaM: number | null;
  ltmAdjEbitdaM: number | null;
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
    ev_revenue_ntm_x: number | null;
    ev_ebitda_x: number | null;
    ev_ebitda_ntm_x: number | null;
  };
  peer_multiples: Array<{
    ticker: string;
    market_cap_m: number;
    ev_m: number;
    ev_revenue_x: number;
    ev_revenue_ntm_x: number | null;
    ev_ebitda_x: number | null;
    ev_ebitda_ntm_x: number | null;
  }>;
  median: { ev_revenue_x: number; ev_revenue_ntm_x: number | null; ev_ebitda_x: number | null; ev_ebitda_ntm_x: number | null };
  mean:   { ev_revenue_x: number; ev_revenue_ntm_x: number | null; ev_ebitda_x: number | null; ev_ebitda_ntm_x: number | null };
  positioning: string;
}

const PEER_SELECT_PROMPT = `You pick a candidate peer set for a Trading Comps analysis.

Output STRICT JSON only:
{
  "peers": [
    { "ticker": "<exchange ticker>", "name": "<company name>", "rationale": "<short phrase explaining inclusion>" }
  ]
}

Rules:
- The caller will ask for N peers. You must propose at LEAST ceil(N * 1.5) candidates so the downstream recency filter has slack to drop delisted/acquired issuers without going below N. Propose the strongest matches FIRST — order matters; the system keeps the first N that pass filtering.
- Pick CURRENTLY PUBLICLY TRADED, standalone companies only. Do NOT include:
  - Companies acquired and absorbed (e.g. Splunk by Cisco 2024, HashiCorp by IBM 2025, Activision by Microsoft 2023)
  - Companies taken private (e.g. Alteryx by Clearlake 2024, Anaplan by Thoma Bravo 2022, Coupa by Thoma Bravo 2023)
  - Companies in active wind-down or bankruptcy
- Comp-universe scope tightness:
    sector_pure → strict pure-play peers (homogeneous business model)
    sector_plus → core + adjacent sub-sectors
    broad       → broader industry / alternative comparables
- Tickers must be current PRIMARY US listings (NYSE / Nasdaq). Avoid OTC tickers, ADRs of dual-listed names, and non-US exchanges.
- Be specific in rationale ("similar PLG SaaS expansion motion", "pure-play observability"); never generic.`;

const MULTIPLES_PROMPT = `You produce trading multiples for a Trading Comps analysis given REAL LTM fundamentals.

The LTM revenue / operating income / gross profit / D&A / SBC / EBITDA / Adjusted EBITDA in the input are SOURCED from SEC XBRL filings. Use them as the denominators. Your job is to estimate market cap, enterprise value, NTM revenue (next-twelve-months consensus), and NTM Adjusted EBITDA, then compute the multiples.

Output STRICT JSON only:
{
  "target_multiples": {
    "market_cap_m": <number, $M>,
    "ev_m": <number, $M>,
    "ev_revenue_x": <ev_m / ltm_revenue_m>,
    "ev_revenue_ntm_x": <ev_m / ntm_revenue_m or null>,
    "ev_ebitda_x": <ev_m / ltm_adj_ebitda_m, null if Adj EBITDA <= 0>,
    "ev_ebitda_ntm_x": <ev_m / ntm_adj_ebitda_m, null if NTM Adj EBITDA <= 0>
  },
  "peer_multiples": [
    {
      "ticker": "<ticker>",
      "market_cap_m": <number>,
      "ev_m": <number>,
      "ev_revenue_x": <number>,
      "ev_revenue_ntm_x": <number or null>,
      "ev_ebitda_x": <number or null>,
      "ev_ebitda_ntm_x": <number or null>
    }
  ],
  "median": { "ev_revenue_x": <n>, "ev_revenue_ntm_x": <n or null>, "ev_ebitda_x": <n or null>, "ev_ebitda_ntm_x": <n or null> },
  "mean":   { "ev_revenue_x": <n>, "ev_revenue_ntm_x": <n or null>, "ev_ebitda_x": <n or null>, "ev_ebitda_ntm_x": <n or null> },
  "positioning": "<2-3 sentence read on how the target prints against the peer set>"
}

Rules:
- Compute LTM multiples using the LTM denominators provided. Do NOT substitute your own LTM estimate.
- For Adj EBITDA multiples, use ltm_adj_ebitda_m (which already adds back D&A and SBC). When that value is null or non-positive, set the EV/EBITDA multiples to null.
- NTM revenue: estimate from your training corpus consensus knowledge; should approximate LTM × (1 + expected growth rate). NTM Adj EBITDA: scale by expected margin trajectory.
- Median/mean skip null entries cleanly (compute over the non-null observations only).
- Anchor market cap to recent (last 12 months) public-equity values you know. Be realistic — no $1T market caps for $1B revenue companies.`;

// Min days of filing recency to keep a peer in the comp set. Beyond this,
// the issuer has likely been delisted / acquired / taken private.
const FILING_RECENCY_DAYS = 180;
// Hard cap on candidate peer count Sonnet can propose.
const MAX_CANDIDATES = 18;
// Over-propose multiplier — Sonnet returns ~1.5× the requested count so
// the recency filter has slack.
const OVERPROPOSE_FACTOR = 1.6;
// Adj EBITDA margin floor for EBITDA multiples to be "meaningful". Below
// this the denominator is so small that EV/EBITDA balloons into the
// hundreds and contaminates median/mean. Industry rule of thumb is ~5%.
const EBITDA_MARGIN_MEANINGFUL_THRESHOLD = 5;

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

  const requestedComps = opts.scope.num_comps ?? 8;
  const numComps = Math.min(requestedComps, MAX_CANDIDATES);
  const numCompsUserSpecified = opts.scope.num_comps != null;
  const candidateTarget = Math.min(Math.ceil(numComps * OVERPROPOSE_FACTOR), MAX_CANDIDATES);
  const universeScope = opts.scope.comp_universe_scope ?? 'sector_plus';
  const universeUserSpecified = opts.scope.comp_universe_scope != null;
  const metricsList = Array.isArray(opts.scope.metrics_focus) ? opts.scope.metrics_focus : ['ev_revenue', 'ev_ebitda', 'ev_revenue_ntm', 'ev_ebitda_ntm'];
  const metricsUserSpecified = Array.isArray(opts.scope.metrics_focus) && opts.scope.metrics_focus.length > 0;
  const metrics = metricsList.join(', ');

  // ---------- Pass 1: Sonnet proposes the candidate ticker list ----------
  yield { type: 'progress', step: `Selecting candidate peer set (${candidateTarget} candidates for ${numComps} kept)…` };
  const peerProposalMessage = `Target: ${pre.entity.name}${pre.entity.ticker ? ` (${pre.entity.ticker})` : ''}
Final peer count requested: ${numComps}
Propose at least ${candidateTarget} candidates (ranked best-first; downstream filter will keep the first ${numComps} that pass SEC-filing recency).
Comp universe scope: ${universeScope}
Original ask: ${opts.query}`;

  let peerProposal: { peers: PeerProposal[] };
  try {
    peerProposal = await sonnetJson<{ peers: PeerProposal[] }>({
      systemPrompt: PEER_SELECT_PROMPT,
      userMessage: peerProposalMessage,
      maxTokens: 1500,
    });
  } catch (err) {
    yield { type: 'error', error: err instanceof Error ? err.message : 'Peer selection failed' };
    yield { type: 'done' };
    return;
  }
  const proposedPeers = (peerProposal.peers ?? []).slice(0, MAX_CANDIDATES);
  if (proposedPeers.length === 0) {
    yield { type: 'error', error: 'No peers could be selected for this target.' };
    yield { type: 'done' };
    return;
  }

  // ---------- Pass 2: Fetch real XBRL LTM for target + each candidate ----------
  yield { type: 'progress', step: `Pulling LTM fundamentals from SEC XBRL for ${proposedPeers.length} candidates…` };

  const targetLtm = pre.entity.cik ? await getLtmFinancialsSafe(pre.entity.cik) : null;

  const now = new Date();
  const recencyCutoff = new Date(now.getTime() - FILING_RECENCY_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const survivors: PeerLtmFundamentals[] = [];
  const droppedPeers: Array<{ ticker: string; name: string; reason: string }> = [];

  for (const p of proposedPeers) {
    if (survivors.length >= numComps) break;
    // Primary lookup: SEC's company_tickers.json. This is fast but
    // INCOMPLETE — it omits issuers who've filed Form 15 (Confluent
    // CFLT did so on 2026-03-27, dropping it from the registry even
    // though its 10-Ks/10-Qs and XBRL are all current).
    let cik: string | null = null;
    let resolvedName = p.name;
    let resolvedTicker = p.ticker.toUpperCase();
    const local = await findByTicker(resolvedTicker);
    if (local) {
      cik = local.cik;
      resolvedName = local.name;
      resolvedTicker = local.ticker;
    } else {
      // Fallback: SEC EDGAR full-text search. ~500ms extra but recovers
      // valid filers missing from the static ticker file.
      const remote = await findCikByTickerViaEdgarSearch(resolvedTicker);
      if (remote) {
        cik = remote.cik;
        resolvedName = remote.name;
      }
    }
    if (!cik) {
      droppedPeers.push({ ticker: p.ticker, name: p.name, reason: 'ticker not resolved via SEC ticker registry or EDGAR full-text search' });
      continue;
    }
    const ltm = await getLtmFinancialsSafe(cik);
    if (!ltm) {
      droppedPeers.push({ ticker: p.ticker, name: resolvedName, reason: 'XBRL companyfacts fetch failed or returned null' });
      continue;
    }
    if (ltm.ltmRevenue == null) {
      droppedPeers.push({ ticker: p.ticker, name: resolvedName, reason: 'XBRL revenue series unparseable for known concepts' });
      continue;
    }
    if (!ltm.latestFilingDate) {
      droppedPeers.push({ ticker: p.ticker, name: resolvedName, reason: 'XBRL data present but no filing-date field' });
      continue;
    }
    if (ltm.latestFilingDate < recencyCutoff) {
      droppedPeers.push({
        ticker: p.ticker,
        name: resolvedName,
        reason: `most recent filing ${ltm.latestFilingDate} is older than ${FILING_RECENCY_DAYS} days`,
      });
      continue;
    }
    survivors.push({
      ticker: resolvedTicker,
      name: resolvedName,
      cik,
      rationale: p.rationale,
      ltmRevenueM: ltm.ltmRevenue,
      ltmOperatingIncomeM: ltm.ltmOperatingIncome,
      ltmGrossProfitM: ltm.ltmGrossProfit,
      ltmDaM: ltm.ltmDepreciationAmortization,
      ltmSbcM: ltm.ltmStockBasedCompensation,
      ltmEbitdaM: ltm.ltmEbitda,
      ltmAdjEbitdaM: ltm.ltmAdjustedEbitda,
      ltmRevenueGrowthPct: ltm.ltmRevenueGrowthPct,
      latestFilingDate: ltm.latestFilingDate,
      periodEnd: ltm.periodEnd ?? '',
      latestForm: ltm.latestForm ?? '10-Q',
    });
  }

  if (survivors.length === 0) {
    yield { type: 'error', error: 'No candidate peers passed the XBRL-recency filter. Try a broader comp universe.' };
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
  for (const peer of survivors) {
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
    meta: 'Market cap, EV, and NTM estimates · model-grounded, not live market data or consensus feed',
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
      label: 'Peers kept',
      value: `${survivors.length} (of ${proposedPeers.length} candidates; requested ${numComps})`,
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
      label: 'Peer LTM revenue / op income / gross profit / D&A / SBC',
      value: `XBRL-sourced for ${survivors.length} peers; recency cutoff ${FILING_RECENCY_DAYS}d`,
      origin: 'sourced',
      sourceRef: 'SEC EDGAR XBRL company facts',
      citationN: pre.entity.cik ? 2 : 1,
    },
    {
      field: 'peer_multiples',
      label: 'Market cap, EV, NTM revenue, NTM EBITDA',
      value: 'Sonnet estimate',
      origin: 'model_knowledge',
      sourceRef: 'Sonnet 4.5 training corpus — no live equity feed, no consensus-estimates feed',
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
    peers: survivors,
    metrics,
  });

  let multiples: SonnetMultiplesOut;
  try {
    multiples = await sonnetJson<SonnetMultiplesOut>({
      systemPrompt: MULTIPLES_PROMPT,
      userMessage: multiplesUserMessage,
      maxTokens: 3500,
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
    survivors,
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

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
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
    if (args.targetLtm.ltmDepreciationAmortization != null) {
      lines.push(`Target LTM D&A: $${args.targetLtm.ltmDepreciationAmortization.toFixed(1)}M`);
    }
    if (args.targetLtm.ltmStockBasedCompensation != null) {
      lines.push(`Target LTM SBC: $${args.targetLtm.ltmStockBasedCompensation.toFixed(1)}M`);
    }
    if (args.targetLtm.ltmEbitda != null) {
      lines.push(`Target LTM EBITDA (= OI + D&A): $${args.targetLtm.ltmEbitda.toFixed(1)}M`);
    }
    if (args.targetLtm.ltmAdjustedEbitda != null) {
      lines.push(`Target LTM Adjusted EBITDA (= OI + D&A + SBC): $${args.targetLtm.ltmAdjustedEbitda.toFixed(1)}M`);
    }
    if (args.targetLtm.ltmRevenueGrowthPct != null) {
      lines.push(`Target LTM YoY revenue growth: ${args.targetLtm.ltmRevenueGrowthPct.toFixed(1)}%`);
    }
  }
  lines.push('');
  lines.push('PEER FUNDAMENTALS (LTM, SEC XBRL, $M):');
  for (const p of args.peers) {
    const parts = [`rev=$${p.ltmRevenueM.toFixed(1)}M`];
    if (p.ltmRevenueGrowthPct != null) parts.push(`growth=${p.ltmRevenueGrowthPct.toFixed(1)}%`);
    if (p.ltmOperatingIncomeM != null) parts.push(`op_inc=$${p.ltmOperatingIncomeM.toFixed(1)}M`);
    if (p.ltmDaM != null) parts.push(`d_and_a=$${p.ltmDaM.toFixed(1)}M`);
    if (p.ltmSbcM != null) parts.push(`sbc=$${p.ltmSbcM.toFixed(1)}M`);
    if (p.ltmEbitdaM != null) parts.push(`ebitda=$${p.ltmEbitdaM.toFixed(1)}M`);
    if (p.ltmAdjEbitdaM != null) parts.push(`adj_ebitda=$${p.ltmAdjEbitdaM.toFixed(1)}M`);
    lines.push(`- ${p.ticker} (${p.name}): ${parts.join(' ')} period_end=${p.periodEnd} filed=${p.latestFilingDate}`);
  }
  lines.push('');
  lines.push(`Metric emphasis: ${args.metrics}`);
  lines.push('Estimate market cap + EV for each company. Compute LTM multiples using the denominators above. Estimate NTM revenue + NTM Adj EBITDA from your training corpus.');
  return lines.join('\n');
}

interface RenderArgs {
  targetName: string;
  targetTicker?: string;
  targetSector: string;
  targetLtm: LtmFinancials | null;
  survivors: PeerLtmFundamentals[];
  droppedPeers: Array<{ ticker: string; name: string; reason: string }>;
  multiples: SonnetMultiplesOut;
}

function renderTradingCompsHtml(args: RenderArgs): string {
  const headline = `<p><strong>${escape(args.targetName)} Trading Comps · ${args.survivors.length} peers · ${escape(args.targetSector)}</strong></p>`;
  const positioning = `<p>${escape(args.multiples.positioning)}</p>`;

  const targetGrowth = args.targetLtm?.ltmRevenueGrowthPct;
  const targetAdjMargin = args.targetLtm?.ltmRevenue && args.targetLtm.ltmAdjustedEbitda != null
    ? (args.targetLtm.ltmAdjustedEbitda / args.targetLtm.ltmRevenue) * 100
    : null;

  const t = args.multiples.target_multiples;
  const targetRow = [
    { value: `${args.targetName}${args.targetTicker ? ` (${args.targetTicker})` : ''}`, strong: true },
    'TARGET',
    fmtMillions(args.targetLtm?.ltmRevenue ?? 0),
    targetGrowth != null ? fmtPctRaw(targetGrowth) : '—',
    targetAdjMargin != null ? fmtPctRaw(targetAdjMargin) : '—',
    fmtMultiple(t.ev_revenue_x),
    t.ev_revenue_ntm_x != null ? fmtMultiple(t.ev_revenue_ntm_x) : '—',
    t.ev_ebitda_x != null ? fmtMultiple(t.ev_ebitda_x) : '—',
    t.ev_ebitda_ntm_x != null ? fmtMultiple(t.ev_ebitda_ntm_x) : '—',
  ];

  const multiplesByTicker = new Map(
    args.multiples.peer_multiples.map(m => [m.ticker.toUpperCase(), m]),
  );
  // Per-peer Adj-EBITDA-margin gate. Margins below the meaningful threshold
  // produce EV/EBITDA values in the hundreds (tiny denominator), which
  // distort any aggregate. Render "n.m." in those cells and exclude them
  // from the recomputed median/mean rows below.
  type PeerCell = { ticker: string; evRevLtm: number | null; evRevNtm: number | null; evEbitdaLtm: number | null; evEbitdaNtm: number | null };
  const peerCells: PeerCell[] = args.survivors.map(p => {
    const m = multiplesByTicker.get(p.ticker.toUpperCase());
    const adjMargin = p.ltmAdjEbitdaM != null && p.ltmRevenueM > 0
      ? (p.ltmAdjEbitdaM / p.ltmRevenueM) * 100
      : null;
    const ebitdaMeaningful = adjMargin != null && adjMargin >= EBITDA_MARGIN_MEANINGFUL_THRESHOLD;
    return {
      ticker: p.ticker,
      evRevLtm: m?.ev_revenue_x ?? null,
      evRevNtm: m?.ev_revenue_ntm_x ?? null,
      evEbitdaLtm: ebitdaMeaningful ? (m?.ev_ebitda_x ?? null) : null,
      evEbitdaNtm: ebitdaMeaningful ? (m?.ev_ebitda_ntm_x ?? null) : null,
    };
  });

  const peerRows = args.survivors.map((p, i) => {
    const m = multiplesByTicker.get(p.ticker.toUpperCase());
    const cell = peerCells[i];
    const adjMargin = p.ltmAdjEbitdaM != null && p.ltmRevenueM > 0
      ? (p.ltmAdjEbitdaM / p.ltmRevenueM) * 100
      : null;
    // Three states for the EBITDA cells:
    //   - margin >= 5% → render the multiple (meaningful)
    //   - margin known but < 5% → 'n.m.' (denominator too small)
    //   - margin null (D&A or SBC missing from XBRL) → '—' (data gap)
    let evEbitdaLtmCell: string;
    let evEbitdaNtmCell: string;
    if (adjMargin == null) {
      evEbitdaLtmCell = '—';
      evEbitdaNtmCell = '—';
    } else if (adjMargin < EBITDA_MARGIN_MEANINGFUL_THRESHOLD) {
      evEbitdaLtmCell = 'n.m.';
      evEbitdaNtmCell = 'n.m.';
    } else {
      evEbitdaLtmCell = m?.ev_ebitda_x != null ? fmtMultiple(m.ev_ebitda_x) : '—';
      evEbitdaNtmCell = m?.ev_ebitda_ntm_x != null ? fmtMultiple(m.ev_ebitda_ntm_x) : '—';
    }
    return [
      p.name,
      p.ticker,
      fmtMillions(p.ltmRevenueM),
      p.ltmRevenueGrowthPct != null ? fmtPctRaw(p.ltmRevenueGrowthPct) : '—',
      adjMargin != null ? fmtPctRaw(adjMargin) : '—',
      cell.evRevLtm != null ? fmtMultiple(cell.evRevLtm) : '—',
      cell.evRevNtm != null ? fmtMultiple(cell.evRevNtm) : '—',
      evEbitdaLtmCell,
      evEbitdaNtmCell,
    ];
  });

  // Recompute median/mean deterministically on the server using only
  // meaningful peer values — Sonnet's reported aggregates can include
  // sub-threshold names and skew the result. Authoritative version
  // overrides whatever the LLM returned.
  const evRevLtmVals = peerCells.map(c => c.evRevLtm).filter((v): v is number => v != null && Number.isFinite(v));
  const evRevNtmVals = peerCells.map(c => c.evRevNtm).filter((v): v is number => v != null && Number.isFinite(v));
  const evEbitdaLtmVals = peerCells.map(c => c.evEbitdaLtm).filter((v): v is number => v != null && Number.isFinite(v));
  const evEbitdaNtmVals = peerCells.map(c => c.evEbitdaNtm).filter((v): v is number => v != null && Number.isFinite(v));

  const medianRow = [
    { value: 'Median', strong: true },
    '', '', '', '',
    median(evRevLtmVals) != null ? fmtMultiple(median(evRevLtmVals)!) : '—',
    median(evRevNtmVals) != null ? fmtMultiple(median(evRevNtmVals)!) : '—',
    median(evEbitdaLtmVals) != null ? fmtMultiple(median(evEbitdaLtmVals)!) : '—',
    median(evEbitdaNtmVals) != null ? fmtMultiple(median(evEbitdaNtmVals)!) : '—',
  ];
  const meanRow = [
    { value: 'Mean', strong: true },
    '', '', '', '',
    mean(evRevLtmVals) != null ? fmtMultiple(mean(evRevLtmVals)!) : '—',
    mean(evRevNtmVals) != null ? fmtMultiple(mean(evRevNtmVals)!) : '—',
    mean(evEbitdaLtmVals) != null ? fmtMultiple(mean(evEbitdaLtmVals)!) : '—',
    mean(evEbitdaNtmVals) != null ? fmtMultiple(mean(evEbitdaNtmVals)!) : '—',
  ];
  // Track two separate exclusion buckets so the data note distinguishes
  // "denominator too small" from "no margin data at all".
  const ebitdaBelowThreshold: string[] = [];
  const ebitdaUnknown: string[] = [];
  args.survivors.forEach((p, i) => {
    const adjMargin = p.ltmAdjEbitdaM != null && p.ltmRevenueM > 0
      ? (p.ltmAdjEbitdaM / p.ltmRevenueM) * 100
      : null;
    if (adjMargin == null) ebitdaUnknown.push(peerCells[i].ticker);
    else if (adjMargin < EBITDA_MARGIN_MEANINGFUL_THRESHOLD) ebitdaBelowThreshold.push(peerCells[i].ticker);
  });

  const compsTable = table({
    compact: true,
    headers: [
      'Company', 'Ticker', 'LTM Rev', 'Rev Growth', 'Adj. EBITDA Mgn',
      'EV/Rev LTM', 'EV/Rev NTM', 'EV/EBITDA LTM', 'EV/EBITDA NTM',
    ],
    rows: [targetRow, ...peerRows, medianRow, meanRow],
    numericColumns: [2, 3, 4, 5, 6, 7, 8],
  });

  const rationaleRows = args.survivors.map(p => [p.ticker, p.name, p.rationale, `${p.latestForm} filed ${p.latestFilingDate}`]);
  const rationaleTable = table({
    compact: true,
    headers: ['Ticker', 'Company', 'Inclusion Rationale', 'Latest Filing'],
    rows: rationaleRows,
  });

  const droppedNote = args.droppedPeers.length > 0
    ? `<strong>Dropped from candidate set:</strong> ${args.droppedPeers
        .map(d => `${escape(d.ticker)} (${escape(d.name)}) — ${escape(d.reason)}`)
        .join('; ')}.`
    : 'All proposed candidates passed the SEC-filing recency filter.';

  const nmParts: string[] = [];
  if (ebitdaBelowThreshold.length > 0) {
    nmParts.push(`<strong>EV/EBITDA "n.m." (not meaningful):</strong> ${ebitdaBelowThreshold.map(escape).join(', ')} — Adj EBITDA margin below ${EBITDA_MARGIN_MEANINGFUL_THRESHOLD}%, denominator too small. Excluded from median/mean.`);
  }
  if (ebitdaUnknown.length > 0) {
    nmParts.push(`<strong>EBITDA margin unavailable:</strong> ${ebitdaUnknown.map(escape).join(', ')} — D&A or SBC missing from the issuer's XBRL filing. Excluded from EBITDA median/mean.`);
  }
  const nmNote = nmParts.length > 0 ? ' ' + nmParts.join(' ') : '';

  return [
    headline,
    positioning,
    note(`<strong>Data sources:</strong> LTM revenue, operating income, gross profit, D&A, and SBC are sourced directly from SEC XBRL company facts (computed as previous_FY + current_YTD − prior_year_YTD when a 10-Q is more recent than the last 10-K). <strong>Adjusted EBITDA = Operating Income + D&A + SBC</strong> (SaaS-standard add-backs). Market cap, enterprise value, and NTM (next-twelve-month) revenue / EBITDA are Sonnet estimates — no live equity-price feed or consensus-estimates feed is currently piped in. ${droppedNote}${nmNote}`),
    section('Comps Table'),
    compsTable,
    section('Peer Inclusion + Recency'),
    rationaleTable,
  ].join('\n');
}
