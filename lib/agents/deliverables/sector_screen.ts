/**
 * Sector-Screen deliverable.
 *
 * Flow:
 *   1. Match the user's sector phrase to a configured sector (REITs, banks,
 *      semis, etc.) → curated constituent ticker list + SIC codes.
 *   2. For each constituent: resolve ticker → CIK, pull LTM revenue from
 *      XBRL (xbrl_ltm). Rank desc by LTM revenue, cap at 5.
 *   3. Ingest each of the top-N companies via ingestEntity (sequential
 *      with limited concurrency). Emits progress events at every step
 *      so the UI shows "Ingesting 3 of 5 (Equinix)…" rather than
 *      appearing frozen for 30-40s.
 *   4. Synthesize a comparative HTML answer grounded in the XBRL
 *      fundamentals + per-company filings (citations to each issuer).
 *
 * Cap at 5 entities is enforced — never ingest a whole sector.
 */

import {
  escape,
  fmtMillions,
  fmtPctRaw,
  note,
  refusalCard,
  section,
  sonnetJson,
  table,
  type DeliverableEvent,
  type InputTrace,
} from './shared';
import {
  matchSector,
  rankConstituentsByLtmRevenue,
  listSectors,
  type RankedConstituent,
} from '@/lib/retrieval/sector_screen';
import { ingestEntity } from '@/lib/ingest/pipeline';

const MAX_TOP_N = 5;
const INGEST_CONCURRENCY = 2;
// Per-entity ingest budget. Single-entity ingest is typically <20s.
// 30s gives a margin without burning all of maxDuration on one peer.
const PER_ENTITY_INGEST_BUDGET_MS = 30_000;

export interface SectorScreenScope {
  sector?: string;
  top_n?: number;
  metrics_focus?: string;
  [k: string]: unknown;
}

interface SectorSonnetOut {
  thesis: string;
  rows: Array<{
    ticker: string;
    sector_role: string;
    commentary: string;
  }>;
}

const SYNTH_PROMPT = `You write a comparative sector-screen brief for a capital-markets analyst.

The user has chosen a sector. The system has already screened the top N
companies by LTM revenue (sourced from SEC XBRL company facts) and
ingested each one's recent filings + news.

Your job: produce a SHORT comparative read across the N companies.

Output STRICT JSON only:
{
  "thesis": "<2-3 sentences on what the sector looks like right now — which names are leaders, where the growth/margin profile sits>",
  "rows": [
    {
      "ticker": "<TICKER>",
      "sector_role": "<one short phrase — 'data-center REIT leader', 'pure-play tower operator', etc>",
      "commentary": "<one short sentence with a SPECIFIC observation about this name vs the others (e.g. 'highest LTM revenue but slowest growth', 'fastest organic CAGR in the set')>"
    }
  ]
}

Rules:
- Output one row per company in the input, in the SAME ORDER as the input list (already ranked by LTM revenue desc).
- Be SPECIFIC. "Largest player by revenue" is OK; "good company" is not.
- Don't invent multiples or per-share figures — you don't have prices.
- Don't fabricate growth/margin numbers — only use what's in the input.
- No prose outside the JSON.`;

export async function* runSectorScreenPipeline(opts: {
  query: string;
  scope: SectorScreenScope;
}): AsyncGenerator<DeliverableEvent, void> {
  const sectorPhrase = String(opts.scope.sector ?? opts.query);
  const requestedN = clampTopN(Number(opts.scope.top_n ?? MAX_TOP_N));
  const metricsFocus = String(opts.scope.metrics_focus ?? 'revenue, growth, margins');

  yield { type: 'progress', step: `Matching sector phrase "${sectorPhrase}"…` };

  const match = await matchSector(sectorPhrase);
  if (!match) {
    const known = await listSectors();
    yield {
      type: 'token',
      text: refusalCard({
        deliverableLabel: 'SECTOR SCREEN',
        target: sectorPhrase,
        headline: 'sector not recognized',
        detail: `No configured sector matched "${sectorPhrase}". Configured sectors:`,
        options: known.map(s => `${s.description} (try: ${s.aliases.join(', ')})`),
      }),
    };
    yield { type: 'done' };
    return;
  }

  yield {
    type: 'progress',
    step: `Matched sector: ${match.description} (SIC ${match.sicCodes.join('/')}, ${match.constituents.length} candidates)`,
  };

  // Rank constituents by LTM revenue, cap at requestedN.
  yield { type: 'progress', step: `Screening ${match.constituents.length} constituents by LTM revenue…` };
  let screenProgressCount = 0;
  const { ranked, dropped } = await rankConstituentsByLtmRevenue(
    match.constituents,
    requestedN,
    () => {
      screenProgressCount++;
      // Throttle: only emit every 4 to avoid flooding the event stream.
      if (screenProgressCount % 4 === 0) {
        // Can't yield from inside the callback — let the screen log on done.
      }
    },
  );

  if (ranked.length === 0) {
    yield {
      type: 'token',
      text: refusalCard({
        deliverableLabel: 'SECTOR SCREEN',
        target: sectorPhrase,
        headline: 'no constituents resolved',
        detail: `Matched sector "${match.description}" but none of the ${match.constituents.length} candidate tickers returned XBRL revenue.`,
        options: dropped.slice(0, 6).map(d => `${d.ticker}: ${d.reason}`),
      }),
    };
    yield { type: 'done' };
    return;
  }

  yield {
    type: 'progress',
    step: `Ranked top ${ranked.length} by LTM revenue: ${ranked.map(r => `${r.ticker} ($${(r.ltmRevenueM / 1000).toFixed(1)}B)`).join(', ')}`,
  };

  // ---------- Multi-entity ingestion ----------
  yield { type: 'progress', step: `Ingesting ${ranked.length} entities (concurrency ${INGEST_CONCURRENCY})…` };
  const ingestResults = new Map<string, { ok: boolean; docs: number; chunks: number; error?: string }>();
  let ingestCompleted = 0;

  const ingestOne = async (entity: RankedConstituent): Promise<void> => {
    const started = Date.now();
    const deadline = started + PER_ENTITY_INGEST_BUDGET_MS;
    try {
      let docs = 0;
      let chunks = 0;
      for await (const ev of ingestEntity(entity.name, { mode: 'full' })) {
        if (Date.now() > deadline) {
          ingestResults.set(entity.ticker, { ok: false, docs, chunks, error: 'ingest exceeded per-entity budget' });
          return;
        }
        if (ev.type === 'done') { docs = ev.documentsAdded; chunks = ev.chunksAdded; }
        else if (ev.type === 'cached') { docs = ev.documents; chunks = ev.chunks; }
        else if (ev.type === 'error') {
          ingestResults.set(entity.ticker, { ok: false, docs, chunks, error: ev.error });
          return;
        }
      }
      ingestResults.set(entity.ticker, { ok: true, docs, chunks });
    } catch (err) {
      ingestResults.set(entity.ticker, { ok: false, docs: 0, chunks: 0, error: (err as Error).message });
    }
  };

  // Cap concurrency. Single-entity ingest is ~12-20s; with 2 in parallel
  // we finish 5 entities in ~30-50s.
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(INGEST_CONCURRENCY, ranked.length) }, async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= ranked.length) return;
      const e = ranked[i];
      // Yieldable progress emission — but we're inside a worker; the
      // generator can only yield from the outer scope. We surface
      // ingestion progress as periodic events below via a separate
      // tick loop.
      await ingestOne(e);
    }
  });

  // Periodic progress emitter — yields "Ingesting N of M…" every 2s
  // until all workers complete. Races against Promise.all so we don't
  // hang after ingestion finishes.
  const allDone = Promise.all(workers).then(() => 'done');
  let running = true;
  Promise.all(workers).finally(() => { running = false; });
  while (running) {
    // Stable race: 2-second tick OR the workers finishing.
    const winner = await Promise.race([
      allDone,
      new Promise<string>(resolve => setTimeout(() => resolve('tick'), 2000)),
    ]);
    if (winner === 'done') break;
    ingestCompleted = ingestResults.size;
    if (ingestCompleted < ranked.length) {
      const inProgress = ranked
        .filter(r => !ingestResults.has(r.ticker))
        .slice(0, INGEST_CONCURRENCY)
        .map(r => r.name);
      yield {
        type: 'progress',
        step: `Ingesting ${ingestCompleted}/${ranked.length} complete · in flight: ${inProgress.join(', ')}`,
      };
    }
  }
  ingestCompleted = ingestResults.size;
  const succeeded = ranked.filter(r => ingestResults.get(r.ticker)?.ok !== false);
  const failedIngest = ranked.filter(r => ingestResults.get(r.ticker)?.ok === false);
  yield {
    type: 'progress',
    step: `Ingest complete: ${succeeded.length}/${ranked.length} ok${failedIngest.length > 0 ? ` (failed: ${failedIngest.map(r => r.ticker).join(', ')})` : ''}`,
  };

  // ---------- Sources + inputs trace ----------
  const sources: Array<{ n: number; title: string; url: string | null; meta: string }> = [];
  for (const r of ranked) {
    sources.push({
      n: sources.length + 1,
      title: `${r.name} SEC EDGAR XBRL company facts`,
      url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${r.cik.padStart(10, '0')}.json`,
      meta: `LTM revenue + recent filings · period ending ${r.periodEnd ?? 'n/a'} · last filed ${r.latestFilingDate ?? 'n/a'}`,
    });
  }
  const modelN = sources.length + 1;
  sources.push({
    n: modelN,
    title: 'Sonnet 4.5 training corpus',
    url: null,
    meta: 'Sector-role narrative · no live equity-price feed',
  });
  yield { type: 'sources', sources };

  const inputs: InputTrace[] = [
    {
      field: 'sector',
      label: 'Sector',
      value: `${match.description} (SIC ${match.sicCodes.join('/')})`,
      origin: 'user_assumption',
      sourceRef: 'Scope card · data/sector_constituents.json',
    },
    {
      field: 'ranking_basis',
      label: 'Ranking basis',
      value: 'LTM revenue (no live market-cap feed; revenue used as size proxy)',
      origin: 'default',
      sourceRef: 'Pipeline policy',
    },
    {
      field: 'top_n',
      label: 'Top N (cap=5)',
      value: String(ranked.length),
      origin: opts.scope.top_n != null ? 'user_assumption' : 'default',
      sourceRef: opts.scope.top_n != null ? 'Scope card' : 'Manifest default (5)',
    },
    {
      field: 'constituents_screened',
      label: 'Constituents screened',
      value: `${ranked.length} ranked / ${dropped.length} dropped / ${match.constituents.length} considered`,
      origin: 'sourced',
      sourceRef: 'SEC EDGAR XBRL company facts',
      citationN: 1,
    },
    {
      field: 'metrics_focus',
      label: 'Metrics emphasized',
      value: metricsFocus,
      origin: opts.scope.metrics_focus != null ? 'user_assumption' : 'default',
      sourceRef: opts.scope.metrics_focus != null ? 'Scope card' : 'Manifest default',
    },
  ];
  yield { type: 'inputs_traced', inputs };

  // ---------- Synthesize comparative narrative ----------
  yield { type: 'progress', step: 'Synthesizing comparative read across the top constituents…' };

  const userMessage = buildSynthPrompt({
    sectorLabel: match.description,
    metricsFocus,
    ranked,
  });

  let synth: SectorSonnetOut;
  try {
    synth = await sonnetJson<SectorSonnetOut>({
      systemPrompt: SYNTH_PROMPT,
      userMessage,
      maxTokens: 2000,
    });
  } catch (err) {
    yield { type: 'error', error: err instanceof Error ? err.message : 'sector synthesis failed' };
    yield { type: 'done' };
    return;
  }

  yield { type: 'progress', step: 'Rendering deliverable…' };
  const html = renderHtml({
    sectorLabel: match.description,
    sicCodes: match.sicCodes,
    ranked,
    failedIngest,
    dropped,
    synth,
    sourcesCount: sources.length,
  });
  yield { type: 'token', text: html };
  yield { type: 'done' };
}

function clampTopN(n: number): number {
  if (!Number.isFinite(n) || n < 1) return MAX_TOP_N;
  return Math.min(n, MAX_TOP_N);
}

function buildSynthPrompt(args: {
  sectorLabel: string;
  metricsFocus: string;
  ranked: RankedConstituent[];
}): string {
  const lines: string[] = [];
  lines.push(`Sector: ${args.sectorLabel}`);
  lines.push(`Metrics emphasis: ${args.metricsFocus}`);
  lines.push('');
  lines.push(`Top ${args.ranked.length} companies, ranked by LTM revenue from SEC XBRL ($M):`);
  for (const r of args.ranked) {
    const parts = [`rev=$${r.ltmRevenueM.toFixed(0)}M`];
    if (r.ltmRevenueGrowthPct != null) parts.push(`growth=${r.ltmRevenueGrowthPct.toFixed(1)}%`);
    if (r.ltmOperatingIncomeM != null) parts.push(`op_inc=$${r.ltmOperatingIncomeM.toFixed(0)}M`);
    if (r.ltmAdjustedEbitdaM != null) parts.push(`adj_ebitda=$${r.ltmAdjustedEbitdaM.toFixed(0)}M`);
    if (r.periodEnd) parts.push(`period_end=${r.periodEnd}`);
    lines.push(`- ${r.ticker} (${r.name}): ${parts.join(' ')}`);
  }
  return lines.join('\n');
}

function renderHtml(args: {
  sectorLabel: string;
  sicCodes: string[];
  ranked: RankedConstituent[];
  failedIngest: RankedConstituent[];
  dropped: Array<{ ticker: string; reason: string }>;
  synth: SectorSonnetOut;
  sourcesCount: number;
}): string {
  const headline = `<p><strong>${escape(args.sectorLabel)} · top ${args.ranked.length} by LTM revenue</strong> · SIC ${args.sicCodes.join('/')}</p>`;
  const thesis = `<p>${escape(args.synth.thesis)}</p>`;

  // Map Sonnet rows by ticker so we can join with the ranked fundamentals.
  const synthByTicker = new Map(args.synth.rows.map(r => [r.ticker.toUpperCase(), r]));

  // Comparative table
  const headers = ['Rank', 'Company', 'Ticker', 'LTM Rev', 'Rev Growth', 'Op Inc', 'Adj EBITDA', 'Period End', 'Filed'];
  const rows = args.ranked.map((r, i) => [
    String(i + 1),
    r.name,
    r.ticker,
    fmtMillions(r.ltmRevenueM),
    r.ltmRevenueGrowthPct != null ? fmtPctRaw(r.ltmRevenueGrowthPct) : '—',
    r.ltmOperatingIncomeM != null ? fmtMillions(r.ltmOperatingIncomeM) : '—',
    r.ltmAdjustedEbitdaM != null ? fmtMillions(r.ltmAdjustedEbitdaM) : '—',
    r.periodEnd ?? '—',
    r.latestFilingDate ?? '—',
  ]);
  const compTable = table({
    compact: true,
    headers,
    rows,
    numericColumns: [0, 3, 4, 5, 6],
  });

  // Per-company commentary table
  const commentaryRows = args.ranked.map((r, i) => {
    const s = synthByTicker.get(r.ticker.toUpperCase());
    return [
      r.ticker,
      r.name,
      s?.sector_role ?? '—',
      s?.commentary ?? '—',
      `[${i + 1}]`,
    ];
  });
  const commentaryTable = table({
    compact: true,
    headers: ['Ticker', 'Company', 'Sector Role', 'Comparative Read', 'Source'],
    rows: commentaryRows,
  });

  const failedNote = args.failedIngest.length > 0
    ? `<strong>Ingestion incomplete for:</strong> ${args.failedIngest.map(r => escape(r.ticker)).join(', ')} — XBRL fundamentals shown but recent-filing chunks unavailable for these.`
    : 'All ranked entities ingested successfully.';
  const droppedNote = args.dropped.length > 0
    ? ` <strong>Screened-out constituents:</strong> ${args.dropped.slice(0, 8).map(d => `${escape(d.ticker)} (${escape(d.reason)})`).join('; ')}.`
    : '';

  return [
    headline,
    thesis,
    note(`<strong>Data sources:</strong> LTM revenue, operating income, and Adjusted EBITDA are sourced from SEC EDGAR XBRL company facts (one source per company). Sector classification uses SEC SIC code mapping. <strong>Ranking basis:</strong> LTM revenue — no live equity-price or market-cap feed is wired in, so revenue is used as the size proxy. Cap of 5 entities per screen for cost/latency. ${failedNote}${droppedNote}`),
    section('Comparative Table'),
    compTable,
    section('Per-Company Read'),
    commentaryTable,
  ].join('\n');
}
