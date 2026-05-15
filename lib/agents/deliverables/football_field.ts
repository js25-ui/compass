/**
 * Football Field valuation deliverable.
 *
 * Takes a list of methodology IDs (trading_comps, precedents, dcf_range,
 * lbo_range, fifty_two_week, analyst_targets) and aggregates each one's
 * implied valuation range onto a common axis. Renders as stacked
 * horizontal bars with an overlap-zone band that signals where the
 * methodologies agree.
 *
 * Source posture:
 *  - Trading comps + precedents + 52-week + analyst-target ranges come
 *    from a single Sonnet call using training knowledge. Tagged
 *    model_knowledge in the input trace — no live market feed.
 *  - DCF / LBO ranges are placeholders today (the corresponding pure
 *    models live in lib/models/ and would need XBRL preflight to anchor
 *    base-year scalars). When the user includes them, Sonnet returns
 *    an implied range as a stand-in and the source ref says so
 *    explicitly. Wiring the pure-model path is one of the next steps;
 *    the manifest already exposes the option so the scope card surface
 *    doesn't change.
 */

import {
  type DeliverableEvent,
  type InputTrace,
  escape,
  fmtMillions,
  note,
  refusalCard,
  section,
  sonnetJson,
  table,
} from './shared';
import { lightPreflight } from '@/lib/data/preflight';

export interface FootballFieldScope {
  methodologies?: string[];
  axis_basis?: 'share_price' | 'equity_value' | 'enterprise_value';
  [k: string]: unknown;
}

const METHODOLOGY_LABELS: Record<string, string> = {
  trading_comps: 'Trading comparables',
  precedents: 'Precedent transactions',
  dcf_range: 'DCF (sensitivity grid)',
  lbo_range: 'LBO (IRR-feasible range)',
  fifty_two_week: '52-week range',
  analyst_targets: 'Analyst targets',
};

interface MethodologyRange {
  id: string;
  label: string;
  low: number;
  mid: number;
  high: number;
  rationale: string;
}

interface SonnetOut {
  ranges: MethodologyRange[];
  axis_label: string;
  axis_unit: string;          // '$M' or '$'
  fair_value_summary: string; // 2-3 sentences
}

function systemPrompt(axisBasis: string): string {
  return `You build a Football Field valuation chart for a capital-markets analyst.

The analyst will give you a target company and a list of methodology IDs.
For each methodology, return an implied valuation range on the ${axisBasis} axis
(low / mid / high), grounded in your training knowledge of the company's
financials, the relevant peer set, and the historical multiples typical
for the sector. Be honest about the freshness — if your knowledge cutoff
predates a major event for this company, say so in rationale.

Output STRICT JSON only:

{
  "ranges": [
    {
      "id": "<methodology id, exactly as given>",
      "label": "<human label, e.g. 'Trading comparables'>",
      "low": <number>,
      "mid": <number>,
      "high": <number>,
      "rationale": "<one specific sentence — e.g. 'Median fast-casual EV/EBITDA 18x × LTM EBITDA $X = $Y; range 12x-24x'>"
    }
  ],
  "axis_label": "<short label for the axis, e.g. 'Enterprise value' or 'Share price'>",
  "axis_unit": "<'$M' if you returned raw millions (e.g. Apple's $3T = 3000000), '$B' if you returned billions (Apple = 3000), '$' for share prices. Pick whichever scales naturally for the target — the renderer will compress upward if needed.>",
  "fair_value_summary": "<2-3 sentence read on where the methodologies overlap and what that implies>"
}

Rules:
- Return ONE range per methodology id given. Do not skip any.
- For 'fifty_two_week' the unit is share price; for 'analyst_targets' also share price.
- For 'trading_comps', 'precedents', 'dcf_range', 'lbo_range' return values in the requested axis basis.
- If the requested axis is equity_value or enterprise_value but a methodology is naturally per-share (52-week, analyst), convert using your best estimate of share count and explain the conversion in rationale.
- low <= mid <= high. Mid should be the methodology's central read, not just the midpoint of low and high.
- Never invent peer companies or deal names — if you can't anchor a range, set low=mid=high=0 and explain "insufficient training-data coverage" in rationale.`;
}

export async function* runFootballFieldPipeline(opts: {
  query: string;
  scope: FootballFieldScope;
  detectedTarget?: { name: string; ticker?: string } | null;
}): AsyncGenerator<DeliverableEvent, void> {
  const target = opts.detectedTarget?.name ?? opts.query;
  yield { type: 'progress', step: `Pre-flight: resolving ${target}…` };

  const pre = await lightPreflight({ query: opts.query, detectedTarget: opts.detectedTarget });
  if (!pre.ok) {
    yield {
      type: 'token',
      text: refusalCard({
        deliverableLabel: 'FOOTBALL FIELD',
        target,
        headline: 'target not found',
        detail: pre.detail,
        options: [
          'Provide a public-company name or ticker.',
          'Football field needs a resolvable entity to anchor each methodology to.',
        ],
      }),
    };
    yield { type: 'done' };
    return;
  }

  const methodologies = Array.isArray(opts.scope.methodologies) && opts.scope.methodologies.length >= 2
    ? opts.scope.methodologies
    : ['trading_comps', 'precedents', 'fifty_two_week', 'analyst_targets'];
  const axisBasis = opts.scope.axis_basis ?? 'equity_value';

  yield { type: 'progress', step: `Gathering ${methodologies.length} methodology ranges for ${pre.entity.name}…` };

  const userMessage = `Target: ${pre.entity.name}${pre.entity.ticker ? ` (${pre.entity.ticker})` : ''}
Filer status: ${pre.hasFilings ? `SEC filer (CIK ${pre.entity.cik})` : 'not a SEC filer'}
Axis basis: ${axisBasis}
Methodology IDs (return ONE entry per id, same order):
${methodologies.map(m => `  - ${m}`).join('\n')}

Original ask: ${opts.query}`;

  let parsed: SonnetOut;
  try {
    parsed = await sonnetJson<SonnetOut>({
      systemPrompt: systemPrompt(axisBasis),
      userMessage,
      maxTokens: 2000,
    });
  } catch (err) {
    yield { type: 'error', error: err instanceof Error ? err.message : 'Football field generation failed' };
    yield { type: 'done' };
    return;
  }

  // Validate Sonnet returned a range per methodology.
  const presentIds = new Set(parsed.ranges.map(r => r.id));
  const missing = methodologies.filter(m => !presentIds.has(m));
  if (missing.length > 0) {
    yield {
      type: 'token',
      text: refusalCard({
        deliverableLabel: 'FOOTBALL FIELD',
        target: pre.entity.name,
        headline: 'incomplete methodology coverage',
        detail: `Sonnet did not return ranges for: ${missing.join(', ')}. Refusing rather than filling gaps with guesses.`,
      }),
    };
    yield { type: 'done' };
    return;
  }

  // Sources: target identity + Sonnet training corpus.
  const sources: Array<{ n: number; title: string; url: string | null; meta: string }> = [];
  if (pre.hasFilings && pre.entity.cik) {
    sources.push({
      n: 1,
      title: `${pre.entity.name} SEC EDGAR profile`,
      url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${pre.entity.cik}`,
      meta: `Entity identity · CIK ${pre.entity.cik}`,
    });
  }
  sources.push({
    n: sources.length + 1,
    title: 'Sonnet 4.5 training corpus',
    url: null,
    meta: 'Methodology ranges (multiples, deal premia, 52-week, analyst targets) — model-grounded, not live market data',
  });
  yield { type: 'sources', sources };

  const modelSourceN = pre.hasFilings ? 2 : 1;
  const inputs: InputTrace[] = [
    {
      field: 'target',
      label: 'Target entity',
      value: `${pre.entity.name}${pre.entity.ticker ? ` (${pre.entity.ticker})` : ''}`,
      origin: 'sourced',
      sourceRef: pre.hasFilings ? `SEC EDGAR · CIK ${pre.entity.cik}` : 'Curated entity',
      citationN: pre.hasFilings ? 1 : undefined,
    },
    {
      field: 'methodologies',
      label: 'Methodologies in scope',
      value: methodologies.map(m => METHODOLOGY_LABELS[m] ?? m).join(', '),
      origin: 'user_assumption',
      sourceRef: 'Scope card',
    },
    {
      field: 'axis_basis',
      label: 'Y-axis basis',
      value: axisBasis,
      origin: 'user_assumption',
      sourceRef: 'Scope card',
    },
    ...parsed.ranges.map((r): InputTrace => ({
      field: `range_${r.id}`,
      label: `${r.label} range`,
      value: `${formatNum(r.low, parsed.axis_unit)} – ${formatNum(r.high, parsed.axis_unit)} (mid ${formatNum(r.mid, parsed.axis_unit)})`,
      origin: 'model_knowledge',
      sourceRef: r.rationale,
      citationN: modelSourceN,
    })),
  ];
  yield { type: 'inputs_traced', inputs };

  yield { type: 'progress', step: 'Rendering football field chart…' };
  yield { type: 'token', text: renderFootballField(pre.entity.name, methodologies, parsed) };
  yield { type: 'done' };
}

function formatNum(n: number, unit: string): string {
  if (!Number.isFinite(n)) return '—';
  // Normalize to a money formatter. Sonnet sometimes returns the axis_unit
  // as '$M' but emits values in billions (Apple's $3T EV is 3000 not
  // 3,000,000) — handle both by branching on magnitude.
  if (unit === '$M') {
    if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}T`;
    if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}B`;
    return `$${Math.round(n).toLocaleString()}M`;
  }
  if (unit === '$B' || unit === '$bn' || unit === 'B') {
    if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(2)}T`;
    return `$${n.toFixed(n < 10 ? 2 : 1)}B`;
  }
  if (unit === '$' || unit === 'USD') {
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
  // Unknown unit — prefix and emit raw.
  return `${unit}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/* ---------- Rendering ---------- */

function renderFootballField(targetName: string, methodologies: string[], out: SonnetOut): string {
  const ranges = methodologies
    .map(m => out.ranges.find(r => r.id === m))
    .filter((r): r is MethodologyRange => Boolean(r));

  // Split into chartable (non-degenerate) vs no-coverage so the SVG only
  // draws bars that have an actual range.
  const chartable = ranges.filter(r => r.high > r.low);

  // Overlap zone — intersection of all chartable ranges.
  const overlapLow = chartable.length ? Math.max(...chartable.map(r => r.low)) : 0;
  const overlapHigh = chartable.length ? Math.min(...chartable.map(r => r.high)) : 0;
  const hasOverlap = chartable.length >= 2 && overlapHigh > overlapLow;

  const overallLow = chartable.length ? Math.min(...chartable.map(r => r.low)) : 0;
  const overallHigh = chartable.length ? Math.max(...chartable.map(r => r.high)) : 1;
  const padding = (overallHigh - overallLow) * 0.05 || 1;
  const axisLow = overallLow - padding;
  const axisHigh = overallHigh + padding;
  const axisSpan = axisHigh - axisLow;

  // SVG layout — only chartable rows get a bar.
  const W = 760;
  const margin = { left: 200, right: 60, top: 30, bottom: 50 };
  const innerW = W - margin.left - margin.right;
  const barH = 26;
  const barGap = 14;
  const innerH = chartable.length * (barH + barGap);
  const H = innerH + margin.top + margin.bottom;

  const xForValue = (v: number) => margin.left + ((v - axisLow) / axisSpan) * innerW;

  const overlapRect = hasOverlap ? `
    <rect x="${xForValue(overlapLow).toFixed(1)}" y="${margin.top}"
          width="${(xForValue(overlapHigh) - xForValue(overlapLow)).toFixed(1)}"
          height="${innerH}"
          fill="#4a90e2" fill-opacity="0.10" stroke="#4a90e2" stroke-opacity="0.5" stroke-dasharray="4 3" />
    <text x="${((xForValue(overlapLow) + xForValue(overlapHigh)) / 2).toFixed(1)}" y="${margin.top - 8}"
          fill="#60a5fa" font-size="11" text-anchor="middle" font-weight="600">
      OVERLAP ${formatNum(overlapLow, out.axis_unit)} – ${formatNum(overlapHigh, out.axis_unit)}
    </text>` : '';

  // Tick marks — 5 evenly spaced
  const ticks: string[] = [];
  for (let i = 0; i <= 5; i++) {
    const v = axisLow + (axisSpan * i) / 5;
    const x = xForValue(v).toFixed(1);
    ticks.push(`
      <line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + innerH}" stroke="#1f1f1f" stroke-width="1" />
      <text x="${x}" y="${margin.top + innerH + 18}" fill="#666" font-size="10" text-anchor="middle">
        ${formatNum(v, out.axis_unit)}
      </text>`);
  }

  const bars = chartable.map((r, i) => {
    const y = margin.top + i * (barH + barGap);
    const xLow = xForValue(r.low);
    const xMid = xForValue(r.mid);
    const xHigh = xForValue(r.high);
    return `
      <text x="${margin.left - 12}" y="${y + barH / 2 + 4}" fill="#ccc" font-size="11" text-anchor="end">${escape(r.label)}</text>
      <rect x="${xLow.toFixed(1)}" y="${y}"
            width="${(xHigh - xLow).toFixed(1)}" height="${barH}"
            fill="#2a3a5a" stroke="#4a90e2" stroke-width="1" />
      <line x1="${xMid.toFixed(1)}" y1="${y}" x2="${xMid.toFixed(1)}" y2="${y + barH}" stroke="#fff" stroke-width="2" />
      <text x="${(xLow - 6).toFixed(1)}" y="${y + barH / 2 + 4}" fill="#888" font-size="10" text-anchor="end">
        ${formatNum(r.low, out.axis_unit)}
      </text>
      <text x="${(xHigh + 6).toFixed(1)}" y="${y + barH / 2 + 4}" fill="#888" font-size="10">
        ${formatNum(r.high, out.axis_unit)}
      </text>`;
  }).join('\n');

  const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" style="background:#0d0d0d;border:1px solid #1f1f1f;display:block;margin:8px 0">
    ${ticks.join('\n')}
    ${overlapRect}
    ${bars}
    <text x="${margin.left + innerW / 2}" y="${H - 8}" fill="#666" font-size="11" text-anchor="middle">
      ${escape(out.axis_label)} (${out.axis_unit})
    </text>
  </svg>`;

  // Rationale table
  const rationaleRows = ranges.map(r => {
    const isDegenerate = !(r.high > r.low);
    return [
      r.label,
      isDegenerate ? 'no coverage' : `${formatNum(r.low, out.axis_unit)} – ${formatNum(r.high, out.axis_unit)}`,
      isDegenerate ? '—' : formatNum(r.mid, out.axis_unit),
      r.rationale,
    ];
  });

  const summary = note(`<strong>Fair-value read:</strong> ${escape(out.fair_value_summary)} ${hasOverlap ? `Overlap zone: <strong>${formatNum(overlapLow, out.axis_unit)} – ${formatNum(overlapHigh, out.axis_unit)}</strong>.` : ''}`);

  return [
    `<p><strong>${escape(targetName)} Football Field · ${ranges.length} methodologies · axis: ${escape(out.axis_label)} (${out.axis_unit})</strong></p>`,
    svg,
    summary,
    section('Methodology ranges'),
    table({
      headers: ['Methodology', 'Range', 'Mid', 'Rationale'],
      rows: rationaleRows,
      numericColumns: [1, 2],
    }),
    note(`<strong>Data note:</strong> Methodology ranges are model-grounded estimates from training knowledge — no live market data feed. DCF/LBO ranges shown here are Sonnet's read of what those models would imply for this target; running the full pure-model pipelines requires the target's XBRL to be indexed.`),
  ].join('\n');
}
