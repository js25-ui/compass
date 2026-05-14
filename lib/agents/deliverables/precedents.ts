/**
 * Precedent Transactions deliverable.
 *
 * Sonnet pulls a precedent M&A set grounded in training-data deal history,
 * with EV / multiples / premium and a one-line note per deal.
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

export interface PrecedentsScope {
  num_precedents?: number;
  precedent_window_months?: number;
  deal_size_min_m?: number;
  buyer_type?: string;        // 'sponsor' | 'strategic' | 'both'
  [k: string]: unknown;
}

interface SonnetOut {
  target_summary: { name: string; sector: string };
  precedents: Array<{
    target: string;
    buyer: string;
    buyer_type: 'sponsor' | 'strategic' | 'mixed';
    deal_date: string;          // YYYY-MM
    ev_m: number;
    ev_revenue_x: number | null;
    ev_ebitda_x: number | null;
    premium_pct: number | null;
    note: string;
  }>;
  aggregates: {
    median_ev_revenue_x: number;
    median_ev_ebitda_x: number;
    median_premium_pct: number;
    mean_ev_revenue_x: number;
    mean_ev_ebitda_x: number;
  };
  read_through: string;          // 2-3 sentence read-through to the target
  caveats: string;
}

const SYSTEM_PROMPT = `You build a Precedent Transactions table for a capital-markets analyst.

Use your training knowledge of M&A history. Pick deals most relevant to the target's sector and size profile.

Output STRICT JSON only:

{
  "target_summary": { "name": "<n>", "sector": "<short>" },
  "precedents": [
    {
      "target": "<acquired company>",
      "buyer": "<buyer>",
      "buyer_type": "<'sponsor' | 'strategic' | 'mixed'>",
      "deal_date": "<YYYY-MM>",
      "ev_m": <number, $M>,
      "ev_revenue_x": <number or null>,
      "ev_ebitda_x": <number or null>,
      "premium_pct": <number or null, % over unaffected>,
      "note": "<one short phrase explaining relevance>"
    }
  ],
  "aggregates": {
    "median_ev_revenue_x": <n>, "median_ev_ebitda_x": <n>,
    "median_premium_pct":  <n>,
    "mean_ev_revenue_x":   <n>, "mean_ev_ebitda_x":   <n>
  },
  "read_through": "<2-3 sentences on what the precedent set implies for valuation of the target>",
  "caveats": "<one sentence on data freshness or selection bias>"
}

Rules:
- Pick the requested number (default 6) of REAL deals. Do not fabricate.
- Prefer deals within the requested time window (default 5 years).
- Buyer type filter: 'sponsor' = PE/sponsor only; 'strategic' = corporate buyers; 'both' = mixed (default).
- For deals where ev_ebitda_x or premium_pct genuinely isn't disclosed, set null. Skip nulls when computing medians/means.
- Be specific in note: "same sub-sector, public-to-private take-private", "strategic consolidation play", "near-equivalent revenue scale".`;

export async function* runPrecedentsPipeline(opts: {
  query: string;
  scope: PrecedentsScope;
  detectedTarget?: { name: string; ticker?: string } | null;
}): AsyncGenerator<DeliverableEvent, void> {
  const target = opts.detectedTarget?.name ?? opts.query;
  yield { type: 'progress', step: `Pre-flight: resolving ${target}…` };
  const pre = await lightPreflight({ query: opts.query, detectedTarget: opts.detectedTarget });
  if (!pre.ok) {
    yield {
      type: 'token',
      text: refusalCard({
        deliverableLabel: 'PRECEDENT TRANSACTIONS',
        target,
        headline: 'target not found',
        detail: pre.detail,
        options: [
          'Provide a known company name or ticker.',
          'For a sector-level deal scan without a specific anchor, ask "recent M&A in [sector]" via chat instead.',
        ],
      }),
    };
    yield { type: 'done' };
    return;
  }

  yield { type: 'progress', step: `Scanning precedents for ${pre.entity.name}…` };

  const userMessage = `Target: ${pre.entity.name}${pre.entity.ticker ? ` (${pre.entity.ticker})` : ''}
Number of precedents: ${opts.scope.num_precedents ?? 6}
Window (months): ${opts.scope.precedent_window_months ?? 60}
Minimum deal size: $${opts.scope.deal_size_min_m ?? 500}M
Buyer type: ${opts.scope.buyer_type ?? 'both'}
Original ask: ${opts.query}`;

  let parsed: SonnetOut;
  try {
    parsed = await sonnetJson<SonnetOut>({ systemPrompt: SYSTEM_PROMPT, userMessage, maxTokens: 2500 });
  } catch (err) {
    yield { type: 'error', error: err instanceof Error ? err.message : 'Precedents generation failed' };
    yield { type: 'done' };
    return;
  }

  yield { type: 'progress', step: 'Rendering deliverable…' };
  yield { type: 'token', text: renderPrecedentsHtml(target, parsed) };
  yield { type: 'done' };
}

function renderPrecedentsHtml(targetName: string, out: SonnetOut): string {
  const headline = `<p><strong>${escape(targetName)} Precedent Transactions · ${out.precedents.length} deals · ${escape(out.target_summary.sector)}</strong></p>`;
  const readThrough = `<p>${escape(out.read_through)}</p>`;

  const rows = out.precedents.map(p => [
    p.target,
    p.buyer,
    p.buyer_type,
    p.deal_date,
    fmtMillions(p.ev_m),
    p.ev_revenue_x != null ? fmtMultiple(p.ev_revenue_x) : '—',
    p.ev_ebitda_x != null ? fmtMultiple(p.ev_ebitda_x) : '—',
    p.premium_pct != null ? fmtPctRaw(p.premium_pct) : '—',
    p.note,
  ]);

  const stats = [
    [
      { value: 'Median', strong: true },
      '',
      '',
      '',
      '',
      { value: fmtMultiple(out.aggregates.median_ev_revenue_x), strong: true, numeric: true },
      { value: fmtMultiple(out.aggregates.median_ev_ebitda_x), strong: true, numeric: true },
      { value: fmtPctRaw(out.aggregates.median_premium_pct), strong: true, numeric: true },
      '',
    ],
    [
      { value: 'Mean', strong: true },
      '',
      '',
      '',
      '',
      { value: fmtMultiple(out.aggregates.mean_ev_revenue_x), strong: true, numeric: true },
      { value: fmtMultiple(out.aggregates.mean_ev_ebitda_x), strong: true, numeric: true },
      '',
      '',
    ],
  ];

  return [
    headline,
    readThrough,
    note(`<strong>Data note:</strong> ${escape(out.caveats)} Precedent multiples are model-grounded; live deal data requires a Dealogic / S&P Capital IQ feed.`),
    section('Precedent Transactions'),
    table({
      compact: true,
      headers: ['Target', 'Buyer', 'Type', 'Date', 'EV', 'EV/Rev', 'EV/EBITDA', 'Premium', 'Note'],
      rows: [...rows, ...stats],
      numericColumns: [4, 5, 6, 7],
    }),
  ].join('\n');
}
