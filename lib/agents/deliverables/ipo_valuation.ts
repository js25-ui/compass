/**
 * IPO Valuation deliverable.
 *
 * Comp-based valuation range + Day-1 distribution. Sonnet picks a peer set,
 * generates the multiples and projected metrics, derives an implied range,
 * and produces a Day-1 percentile distribution.
 */

import {
  type DeliverableEvent,
  escape,
  fmtMillions,
  fmtMultiple,
  fmtPctRaw,
  note,
  section,
  sonnetJson,
  table,
} from './shared';
import { IPO_MANIFEST } from '@/lib/models/manifests';
import { preflight } from '@/lib/data/preflight';

export interface IPOValuationScope {
  num_peers?: number;
  precedent_window_months?: number;
  pricing_anchor?: string;        // 'ev_revenue' | 'ev_ebitda' | 'pe' | 'mixed'
  [k: string]: unknown;
}

interface ValuationRow {
  method: string;
  multiple_x: number;
  metric_label: string;
  metric_value_m: number;
  implied_ev_m: number;
  implied_market_cap_m: number;
  implied_share_price: number;
}

interface SonnetOut {
  target_summary: {
    name: string;
    ticker?: string;
    sector: string;
    expected_shares_outstanding_m: number;     // post-IPO basic, in millions
    ltm_revenue_m: number;
    ltm_ebitda_m: number;
    ntm_revenue_m: number;
    ntm_ebitda_m: number;
    proposed_price_range: { low: number; high: number };
  };
  peers: Array<{
    name: string;
    ticker: string;
    revenue_growth_pct: number;
    ebitda_margin_pct: number;
    ev_ntm_revenue_x: number;
    ev_ntm_ebitda_x: number;
  }>;
  peer_aggregates: {
    median_ev_revenue_x: number;
    median_ev_ebitda_x: number;
    mean_ev_revenue_x: number;
    mean_ev_ebitda_x: number;
  };
  valuation: {
    rows: ValuationRow[];
    implied_range_low: number;
    implied_midpoint: number;
    implied_range_high: number;
    implied_share_price_low: number;
    implied_share_price_mid: number;
    implied_share_price_high: number;
  };
  day1: {
    p5_pct: number;
    p25_pct: number;
    p50_pct: number;
    p75_pct: number;
    p95_pct: number;
    p_above_issue: number;       // decimal 0-1
    p_pop_over_50: number;       // decimal 0-1
  };
  recommendation: string;          // 1-2 sentence pricing recommendation
  caveats: string;
}

const SYSTEM_PROMPT = `You build an IPO Valuation deliverable for a capital-markets analyst.

Pick a peer set of public companies most relevant to the IPO target. Use forward (NTM) multiples to anchor the implied range; LTM as a sanity check. Output STRICT JSON only:

{
  "target_summary": {
    "name": "<canonical name>",
    "ticker": "<post-IPO ticker if proposed>",
    "sector": "<short sector>",
    "expected_shares_outstanding_m": <post-IPO basic shares, millions>,
    "ltm_revenue_m": <number>,
    "ltm_ebitda_m": <number>,
    "ntm_revenue_m": <number>,
    "ntm_ebitda_m": <number>,
    "proposed_price_range": { "low": <number>, "high": <number> }
  },
  "peers": [
    { "name": "<name>", "ticker": "<tk>", "revenue_growth_pct": <n>, "ebitda_margin_pct": <n>,
      "ev_ntm_revenue_x": <n>, "ev_ntm_ebitda_x": <n> }
  ],
  "peer_aggregates": {
    "median_ev_revenue_x": <n>, "median_ev_ebitda_x": <n>,
    "mean_ev_revenue_x":   <n>, "mean_ev_ebitda_x":   <n>
  },
  "valuation": {
    "rows": [
      { "method": "EV/NTM Revenue (peer median)", "multiple_x": <n>,
        "metric_label": "NTM Revenue", "metric_value_m": <n>,
        "implied_ev_m": <n>, "implied_market_cap_m": <n>,
        "implied_share_price": <n> },
      ... 4-6 rows total: low/median/high cuts of each anchor multiple, plus a precedent IPO comp if relevant
    ],
    "implied_range_low": <n, $M EV>,
    "implied_midpoint":  <n, $M EV>,
    "implied_range_high":<n, $M EV>,
    "implied_share_price_low":  <n>,
    "implied_share_price_mid":  <n>,
    "implied_share_price_high": <n>
  },
  "day1": {
    "p5_pct": <number, e.g. -8 for -8% return>,
    "p25_pct": <n>, "p50_pct": <n>, "p75_pct": <n>, "p95_pct": <n>,
    "p_above_issue": <decimal 0-1>,
    "p_pop_over_50": <decimal 0-1>
  },
  "recommendation": "<one or two sentences specifying where to price within the range and why, e.g. 'Recommend pricing at \\$22, top of \\$19-21 range; demand book and momentum support max-end allocation.'>",
  "caveats": "<one sentence flagging any data gaps or assumption sensitivity>"
}

Rules:
- Use the requested number of peers (default 8).
- For peers, prefer recent IPOs in the same sector when available — they're more pricing-relevant than mature names.
- Implied share price = implied_market_cap_m * 1_000_000 / (expected_shares_outstanding_m * 1_000_000) = implied_market_cap_m / expected_shares_outstanding_m. Use this consistently.
- p_above_issue is the probability the stock closes Day-1 above issue price; p_pop_over_50 is the probability it pops more than 50%.
- Day-1 percentiles are returns vs. issue price, in percent (e.g. 28 = +28%).
- Be specific in recommendation — name an actual price point if possible.`;

export async function* runIPOValuationPipeline(opts: {
  query: string;
  scope: IPOValuationScope;
  detectedTarget?: { name: string; ticker?: string } | null;
}): AsyncGenerator<DeliverableEvent, void> {
  const target = opts.detectedTarget?.name ?? opts.query;
  yield { type: 'progress', step: `Pre-flight: checking ${target} financial history…` };

  const pre = await preflight({
    query: opts.query,
    detectedTarget: opts.detectedTarget,
    manifest: IPO_MANIFEST,
  });
  if (!pre.ok) {
    yield { type: 'token', text: renderIPOPreflightFailureHtml(target, pre.detail, pre.missingMetrics, pre.attempted) };
    yield { type: 'done' };
    return;
  }

  const revHistory = pre.history.revenue ?? [];
  const realFinancials = revHistory.length > 0
    ? `\nReal revenue history from XBRL: ${revHistory.map(f => `${f.period}: $${f.value?.toFixed(0)}M`).join(', ')}.`
    : '';

  const userMessage = `Target: ${target}${opts.detectedTarget?.ticker ? ` (proposed ticker ${opts.detectedTarget.ticker})` : ''}
Number of peers: ${opts.scope.num_peers ?? 8}
Precedent window (months): ${opts.scope.precedent_window_months ?? 18}
Pricing anchor: ${opts.scope.pricing_anchor ?? 'mixed'}
Original ask: ${opts.query}${realFinancials}`;

  yield { type: 'progress', step: 'Building valuation matrix and Day-1 distribution…' };

  let parsed: SonnetOut;
  try {
    parsed = await sonnetJson<SonnetOut>({ systemPrompt: SYSTEM_PROMPT, userMessage, maxTokens: 3500 });
  } catch (err) {
    yield { type: 'error', error: err instanceof Error ? err.message : 'IPO valuation generation failed' };
    return;
  }

  yield { type: 'progress', step: 'Rendering deliverable…' };
  yield { type: 'token', text: renderIPOValuationHtml(target, parsed) };
  yield { type: 'done' };
}

function renderIPOPreflightFailureHtml(target: string, detail: string, missing: string[], attempted: string[]): string {
  return [
    `<div class="memo-rec-banner" style="border-left-color:#fbbf24">
       <div class="memo-rec-label" style="color:#fbbf24">CANNOT RUN IPO VALUATION</div>
       <div class="memo-rec-headline">${escape(target)}: required revenue history not available</div>
     </div>`,
    `<p>${escape(detail)}</p>`,
    missing.length > 0 ? `<p><strong>Missing required data:</strong> ${missing.map(m => `<code>${escape(m)}</code>`).join(', ')}.</p>` : '',
    `<p><strong>Options:</strong></p>
     <ul class="memo-bullets">
       <li>→ For a private pre-IPO company, provide expected revenue (current fiscal year and forward) manually.</li>
       <li>→ For a recently-public company, ensure the target has at least one fiscal year of 10-K filings.</li>
       <li>→ Use Trading Comps instead — comp-based valuation works without target-specific filings.</li>
     </ul>`,
    `<p class="memo-disclaimer">Sources attempted: ${attempted.join(' → ')}.</p>`,
    `<p class="memo-disclaimer">Compass refuses to fabricate target revenue / margin / shares-outstanding for an IPO valuation. The output would look credible but the implied range would be made up.</p>`,
  ].join('\n');
}

function renderIPOValuationHtml(targetName: string, out: SonnetOut): string {
  const t = out.target_summary;
  const v = out.valuation;
  const d = out.day1;

  const headline = `<p><strong>${escape(targetName)} IPO Valuation · ${out.peers.length} peers · ${escape(t.sector)}</strong></p>`;

  const recommendation = `<p>${escape(out.recommendation)}</p>`;

  const targetTable = table({
    headers: ['Item', 'Value'],
    rows: [
      ['Proposed Range', `$${t.proposed_price_range.low.toFixed(2)} – $${t.proposed_price_range.high.toFixed(2)}`],
      ['Expected Post-IPO Shares', `${t.expected_shares_outstanding_m.toFixed(1)}M`],
      ['LTM Revenue', fmtMillions(t.ltm_revenue_m)],
      ['LTM EBITDA', fmtMillions(t.ltm_ebitda_m)],
      ['NTM Revenue', fmtMillions(t.ntm_revenue_m)],
      ['NTM EBITDA', fmtMillions(t.ntm_ebitda_m)],
    ],
    numericColumns: [1],
  });

  const valuationRows = v.rows.map(r => [
    r.method,
    fmtMultiple(r.multiple_x),
    r.metric_label,
    fmtMillions(r.metric_value_m),
    fmtMillions(r.implied_ev_m),
    fmtMillions(r.implied_market_cap_m),
    `$${r.implied_share_price.toFixed(2)}`,
  ]);

  const valuationTable = table({
    compact: true,
    headers: ['Method', 'Multiple', 'Metric', 'Value', 'Implied EV', 'Implied Mkt Cap', 'Implied $/Sh'],
    rows: valuationRows,
    numericColumns: [1, 3, 4, 5, 6],
  });

  const rangeTable = table({
    headers: ['Range', 'EV', 'Share Price'],
    rows: [
      ['Low', fmtMillions(v.implied_range_low), `$${v.implied_share_price_low.toFixed(2)}`],
      [{ value: 'Midpoint', strong: true }, { value: fmtMillions(v.implied_midpoint), strong: true, numeric: true }, { value: `$${v.implied_share_price_mid.toFixed(2)}`, strong: true, numeric: true }],
      ['High', fmtMillions(v.implied_range_high), `$${v.implied_share_price_high.toFixed(2)}`],
    ],
    numericColumns: [1, 2],
  });

  const peerTable = table({
    compact: true,
    headers: ['Peer', 'Ticker', 'Rev Growth', 'EBITDA Mgn', 'EV/NTM Rev', 'EV/NTM EBITDA'],
    rows: out.peers.map(p => [
      p.name,
      p.ticker,
      fmtPctRaw(p.revenue_growth_pct),
      fmtPctRaw(p.ebitda_margin_pct),
      fmtMultiple(p.ev_ntm_revenue_x),
      p.ev_ntm_ebitda_x ? fmtMultiple(p.ev_ntm_ebitda_x) : '—',
    ]),
    numericColumns: [2, 3, 4, 5],
  });

  const day1Table = table({
    headers: ['Percentile', 'Day-1 Return'],
    rows: [
      ['P5', fmtPctRaw(d.p5_pct)],
      ['P25', fmtPctRaw(d.p25_pct)],
      [{ value: 'P50 (Median)', strong: true }, { value: fmtPctRaw(d.p50_pct), strong: true, numeric: true, highlight: true }],
      ['P75', fmtPctRaw(d.p75_pct)],
      ['P95', fmtPctRaw(d.p95_pct)],
      ['P(close > issue)', fmtPctRaw(d.p_above_issue * 100)],
      ['P(pop > 50%)', fmtPctRaw(d.p_pop_over_50 * 100)],
    ],
    numericColumns: [1],
  });

  return [
    headline,
    recommendation,
    note(`<strong>Data note:</strong> ${escape(out.caveats)} Peer multiples and Day-1 distribution are model-grounded estimates.`),
    section('Target Profile'),
    targetTable,
    section('Comp-Based Valuation'),
    valuationTable,
    section('Implied Range'),
    rangeTable,
    section('Peer Set'),
    peerTable,
    section('Day-1 Aftermarket Distribution'),
    day1Table,
  ].join('\n');
}
