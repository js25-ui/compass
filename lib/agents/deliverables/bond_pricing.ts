/**
 * Bond Pricing deliverable.
 *
 * Sonnet picks comparable issuers + recent issuance prints, anchors a spread
 * recommendation, and runs a small set of rate scenarios.
 */

import {
  type DeliverableEvent,
  escape,
  fmtBps,
  fmtMillions,
  fmtPctRaw,
  note,
  section,
  sonnetJson,
  table,
} from './shared';
import { BOND_MANIFEST } from '@/lib/models/manifests';
import { preflight } from '@/lib/data/preflight';

export interface BondPricingScope {
  tenor_years?: number;
  issue_size_m?: number;
  comp_window_months?: number;
  rating?: string;
  use_of_proceeds?: string;
  [k: string]: unknown;
}

interface SonnetOut {
  issuer_summary: {
    name: string;
    ticker?: string;
    rating: string;
    sector: string;
    tenor_years: number;
    proposed_size_m: number;
    use_of_proceeds: string;
  };
  recommendation: {
    spread_bps: number;
    coupon_pct: number;
    treasury_benchmark_yield_pct: number;
    new_issue_concession_bps: number;
    rationale: string;             // 2-3 sentences
  };
  comp_set: Array<{
    issuer: string;
    ticker?: string;
    rating: string;
    tenor_years: number;
    issue_date: string;
    size_m: number;
    spread_bps: number;
    coupon_pct: number;
    note: string;
  }>;
  comp_aggregates: {
    median_spread_bps: number;
    mean_spread_bps: number;
    median_coupon_pct: number;
  };
  scenarios: Array<{
    name: string;                  // "Base" | "Tight" | "Wide" | etc.
    treasury_yield_pct: number;
    spread_bps: number;
    all_in_yield_pct: number;
    annual_coupon_m: number;
    debt_service_coverage_x: number;
  }>;
  technicals: string;              // 1-2 sentences on flows / fund flows / IG OAS / supply
  caveats: string;
}

const SYSTEM_PROMPT = `You build a Bond Pricing memo for a capital-markets analyst.

The user is pricing a new issue. Identify a tight comp set of recent same-rating same-tenor issuance, anchor a spread-to-Treasury recommendation, and stress with rate scenarios.

Output STRICT JSON only:

{
  "issuer_summary": {
    "name": "<canonical issuer>",
    "ticker": "<ticker if public>",
    "rating": "<S&P/Moody's, e.g. 'BBB+/Baa1'>",
    "sector": "<sector>",
    "tenor_years": <n>,
    "proposed_size_m": <n>,
    "use_of_proceeds": "<short>"
  },
  "recommendation": {
    "spread_bps": <n>,
    "coupon_pct": <n>,
    "treasury_benchmark_yield_pct": <n, current treasury yield at the matched tenor>,
    "new_issue_concession_bps": <n, vs. existing curve>,
    "rationale": "<2-3 sentences explaining the spread call: order book signal, comp positioning, technicals>"
  },
  "comp_set": [
    { "issuer": "<n>", "ticker": "<tk>", "rating": "<r>", "tenor_years": <n>,
      "issue_date": "<YYYY-MM>", "size_m": <n>, "spread_bps": <n>, "coupon_pct": <n>,
      "note": "<one short phrase, e.g. 'most direct comp; pure-play industrial 30Y'>" }
  ],
  "comp_aggregates": {
    "median_spread_bps": <n>, "mean_spread_bps": <n>, "median_coupon_pct": <n>
  },
  "scenarios": [
    { "name": "Base",  "treasury_yield_pct": <n>, "spread_bps": <n>, "all_in_yield_pct": <n>,
      "annual_coupon_m": <n>, "debt_service_coverage_x": <n> },
    { "name": "Tight", "treasury_yield_pct": <n>, "spread_bps": <n>, "all_in_yield_pct": <n>,
      "annual_coupon_m": <n>, "debt_service_coverage_x": <n> },
    { "name": "Wide",  "treasury_yield_pct": <n>, "spread_bps": <n>, "all_in_yield_pct": <n>,
      "annual_coupon_m": <n>, "debt_service_coverage_x": <n> }
  ],
  "technicals": "<one or two sentences on IG/HY flows, recent issuance pace, IG OAS direction>",
  "caveats": "<one sentence flagging stale data or assumption sensitivity>"
}

Rules:
- Pick 4-6 comps, prefer same rating + same tenor + last 12 months.
- Default tenor is 10Y for IG corporate when not specified.
- For HY (BB+ and below) bias the recommendation rationale toward credit quality and OAS context, not just rate level.
- Sovereigns / agencies / munis: use the appropriate benchmark (Bunds, Treasuries, MMD scale) and call it out.
- annual_coupon_m = proposed_size_m * (all_in_yield_pct / 100).
- Be specific in rationale — name names ("inside Boeing 30Y by 5 bps", "tight to Cat 30Y at T+125").`;

export async function* runBondPricingPipeline(opts: {
  query: string;
  scope: BondPricingScope;
  detectedTarget?: { name: string; ticker?: string } | null;
}): AsyncGenerator<DeliverableEvent, void> {
  const target = opts.detectedTarget?.name ?? opts.query;
  yield { type: 'progress', step: `Pre-flight: checking ${target} credit profile…` };

  const pre = await preflight({
    query: opts.query,
    detectedTarget: opts.detectedTarget,
    manifest: BOND_MANIFEST,
  });
  if (!pre.ok) {
    // Sovereigns / supras don't have SEC filings but ARE valid bond issuers.
    // For now we still refuse on missing financials — same honest-failure
    // pattern as LBO, with a sovereign/muni-specific path coming later.
    yield { type: 'token', text: renderBondPreflightFailureHtml(target, pre.detail, pre.missingMetrics, pre.attempted) };
    yield { type: 'done' };
    return;
  }

  const realCreditNote = `\nReal financials from XBRL: revenue $${pre.scalar.revenue.toFixed(0)}M, operating income $${(pre.scalar.operating_income ?? 0).toFixed(0)}M${pre.scalar.long_term_debt ? `, long-term debt $${pre.scalar.long_term_debt.toFixed(0)}M` : ''}.`;

  const userMessage = `Issuer: ${target}${opts.detectedTarget?.ticker ? ` (${opts.detectedTarget.ticker})` : ''}
Tenor: ${opts.scope.tenor_years ?? 10} years
Proposed size: $${opts.scope.issue_size_m ?? 1000}M
Comp window: ${opts.scope.comp_window_months ?? 12} months
Rating override: ${opts.scope.rating ?? 'use issuer current'}
Use of proceeds: ${opts.scope.use_of_proceeds ?? 'general corporate purposes'}
Original ask: ${opts.query}${realCreditNote}`;

  yield { type: 'progress', step: 'Anchoring spread vs. comp set + running rate scenarios…' };

  let parsed: SonnetOut;
  try {
    parsed = await sonnetJson<SonnetOut>({ systemPrompt: SYSTEM_PROMPT, userMessage, maxTokens: 3000 });
  } catch (err) {
    yield { type: 'error', error: err instanceof Error ? err.message : 'Bond pricing generation failed' };
    return;
  }

  yield { type: 'progress', step: 'Rendering deliverable…' };
  yield { type: 'token', text: renderBondPricingHtml(target, parsed) };
  yield { type: 'done' };
}

function renderBondPreflightFailureHtml(target: string, detail: string, missing: string[], attempted: string[]): string {
  return [
    `<div class="memo-rec-banner" style="border-left-color:#fbbf24">
       <div class="memo-rec-label" style="color:#fbbf24">CANNOT RUN BOND PRICING</div>
       <div class="memo-rec-headline">${escape(target)}: required issuer financials not available</div>
     </div>`,
    `<p>${escape(detail)}</p>`,
    missing.length > 0 ? `<p><strong>Missing required data:</strong> ${missing.map(m => `<code>${escape(m)}</code>`).join(', ')}.</p>` : '',
    `<p><strong>Options:</strong></p>
     <ul class="memo-bullets">
       <li>→ For a public corporate issuer with SEC filings, double-check the entity name (try the ticker).</li>
       <li>→ Sovereigns / supras / munis don't appear in SEC XBRL — sovereign bond pricing pipeline coming next.</li>
       <li>→ Provide issuer revenue and operating income manually if you have them off-platform.</li>
     </ul>`,
    `<p class="memo-disclaimer">Sources attempted: ${attempted.join(' → ')}.</p>`,
    `<p class="memo-disclaimer">Compass refuses to fabricate issuer credit metrics. Spread recommendation needs real numbers to be defensible.</p>`,
  ].join('\n');
}

function renderBondPricingHtml(targetName: string, out: SonnetOut): string {
  const i = out.issuer_summary;
  const r = out.recommendation;

  const headline = `<p><strong>${escape(targetName)} ${i.tenor_years}Y · ${escape(i.rating)} · ${fmtMillions(i.proposed_size_m)} new issue</strong></p>`;

  const recBanner = `<p><strong>Recommend pricing at T+${Math.round(r.spread_bps)} (${fmtPctRaw(r.coupon_pct)} coupon).</strong> ${escape(r.rationale)}</p>`;

  const issuerTable = table({
    headers: ['Item', 'Value'],
    rows: [
      ['Issuer', i.name + (i.ticker ? ` (${i.ticker})` : '')],
      ['Rating', i.rating],
      ['Sector', i.sector],
      ['Tenor', `${i.tenor_years} years`],
      ['Size', fmtMillions(i.proposed_size_m)],
      ['Use of Proceeds', i.use_of_proceeds],
    ],
    numericColumns: [],
  });

  const recTable = table({
    headers: ['Item', 'Value'],
    rows: [
      ['Treasury Benchmark', fmtPctRaw(r.treasury_benchmark_yield_pct, 2)],
      [{ value: 'Spread', strong: true }, { value: fmtBps(r.spread_bps), strong: true, numeric: true }],
      [{ value: 'All-in Yield (Coupon)', strong: true }, { value: fmtPctRaw(r.coupon_pct, 3), strong: true, numeric: true }],
      ['New Issue Concession vs. existing curve', fmtBps(r.new_issue_concession_bps)],
      ['Comp Set Median Spread', fmtBps(out.comp_aggregates.median_spread_bps)],
      ['Comp Set Mean Spread', fmtBps(out.comp_aggregates.mean_spread_bps)],
    ],
    numericColumns: [1],
  });

  const compRows = out.comp_set.map(c => [
    c.issuer + (c.ticker ? ` (${c.ticker})` : ''),
    c.rating,
    `${c.tenor_years}Y`,
    c.issue_date,
    fmtMillions(c.size_m),
    fmtBps(c.spread_bps),
    fmtPctRaw(c.coupon_pct, 3),
    c.note,
  ]);

  const compTable = table({
    compact: true,
    headers: ['Issuer', 'Rating', 'Tenor', 'Issued', 'Size', 'Spread', 'Coupon', 'Note'],
    rows: compRows,
    numericColumns: [4, 5, 6],
  });

  const scenarioRows = out.scenarios.map(s => [
    s.name,
    fmtPctRaw(s.treasury_yield_pct, 2),
    fmtBps(s.spread_bps),
    fmtPctRaw(s.all_in_yield_pct, 3),
    fmtMillions(s.annual_coupon_m),
    `${s.debt_service_coverage_x.toFixed(1)}x`,
  ]);

  const scenarioTable = table({
    headers: ['Scenario', 'Treasury', 'Spread', 'All-in Yield', 'Annual Coupon $', 'Coverage'],
    rows: scenarioRows,
    numericColumns: [1, 2, 3, 4, 5],
  });

  return [
    headline,
    recBanner,
    note(`<strong>Data note:</strong> ${escape(out.caveats)} Comp prints and scenario assumptions are model-grounded; live spread quotes require a market data feed.`),
    section('Issuer Profile'),
    issuerTable,
    section('Pricing Recommendation'),
    recTable,
    section('Comp Set'),
    compTable,
    section('Rate / Spread Scenarios'),
    scenarioTable,
    section('Market Technicals'),
    `<p>${escape(out.technicals)}</p>`,
  ].join('\n');
}
