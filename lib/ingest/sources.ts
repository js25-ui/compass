import { createHash } from 'node:crypto';
import { fetchFilingText, listFilings } from '@/lib/retrieval/edgar';
import { fetchSeries, MACRO_SERIES, type MacroSeriesKey } from '@/lib/retrieval/fred';
import { searchArticles } from '@/lib/retrieval/gdelt';
import { fetchNewsForEntity } from '@/lib/retrieval/news_rss';
import { reconcileArticleDate, resolveCanonicalDates } from '@/lib/retrieval/article_date';
import { getAnnualFinancials } from '@/lib/retrieval/xbrl';
import type { ResolvedEntity } from '@/lib/lookup/resolve';
import type { TimeRange } from '@/lib/queries/time_range';
import type { Json } from '@/lib/db/types';

export interface PendingDocument {
  id: string;
  source: string;
  doc_type: string;
  title: string;
  url: string | null;
  content_full: string | null;
  filed_at: string | null;
  metadata: Json;
  is_primary_source: boolean;
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/* -------------------- EDGAR filings + XBRL -------------------- */

export interface EdgarFetchOpts {
  withFullText: boolean;          // false in numerical mode
  timeRange?: TimeRange;
  maxFilings: number;
}

export async function fetchEdgarFilings(
  entity: ResolvedEntity,
  opts: EdgarFetchOpts,
): Promise<PendingDocument[]> {
  if (!entity.cik) return [];
  const filings = await listFilings(entity.cik, {
    limit: opts.maxFilings,
    fromDate: opts.timeRange?.start.toISOString().slice(0, 10),
    toDate: opts.timeRange?.end.toISOString().slice(0, 10),
  });

  const docs: PendingDocument[] = [];
  for (const filing of filings) {
    let content: string | null = null;
    if (opts.withFullText) {
      try {
        content = await fetchFilingText(filing);
      } catch {
        // skip this filing's text on fetch failure; still keep the metadata row
      }
    }
    docs.push({
      id: `edgar-${filing.accessionNumber}`,
      source: 'sec_edgar',
      doc_type: filing.formType,
      title: `${filing.formType} ${filing.filedAt} (${entity.name})`,
      url: filing.primaryDocumentUrl,
      content_full: content,
      filed_at: filing.filedAt,
      metadata: {
        kind: 'edgar_filing',
        form_type: filing.formType,
        accession_number: filing.accessionNumber,
        report_date: filing.reportDate,
      } satisfies Json,
      is_primary_source: true,
    });
  }
  return docs;
}

export async function fetchEdgarXbrl(entity: ResolvedEntity): Promise<PendingDocument[]> {
  if (!entity.cik) return [];
  const annuals = await getAnnualFinancials(entity.cik);
  if (annuals.length === 0) return [];
  return [
    {
      id: `xbrl-${entity.cik}`,
      source: 'sec_edgar',
      doc_type: 'xbrl_facts',
      title: `${entity.name} · XBRL annual facts`,
      url: `https://data.sec.gov/api/xbrl/companyfacts/CIK${entity.cik.padStart(10, '0')}.json`,
      content_full: null,
      filed_at: annuals[annuals.length - 1].source.filed,
      metadata: {
        kind: 'xbrl_annual_facts',
        years: annuals.length,
        first_fy: annuals[0].fy,
        last_fy: annuals[annuals.length - 1].fy,
        // Intentionally store the full annual series in metadata — small, structured,
        // hot-path-readable without hitting EDGAR again.
        facts: annuals as unknown as Json,
      } satisfies Json,
      is_primary_source: true,
    },
  ];
}

/* -------------------- News RSS + GDELT -------------------- */

export interface ArticleFetchOpts {
  maxArticles: number;
}

export async function fetchNews(
  entity: ResolvedEntity,
  opts: ArticleFetchOpts,
): Promise<PendingDocument[]> {
  const items = await fetchNewsForEntity({ ticker: entity.ticker, query: entity.name });
  const sliced = items.slice(0, opts.maxArticles);
  // Best-effort: fetch each article's canonical published-time from
  // <meta property="article:published_time"> etc. RSS pubDate from
  // Google News / Yahoo Finance reflects when the AGGREGATOR indexed
  // the article, which for syndicated content (MSN re-hosting USA
  // Today, Yahoo News re-hosting Reuters) can be days off the real
  // publication. reconcileArticleDate prefers the canonical date when
  // it's meaningfully earlier than the feed date.
  const canonicalDates = await resolveCanonicalDates(sliced.map(s => s.link));
  return sliced.map((item, i) => {
    const resolved = reconcileArticleDate(item.pubDate, canonicalDates[i]);
    return {
      id: `news-${shortHash(item.link)}`,
      source: 'news_rss',
      doc_type: 'news',
      title: item.title,
      url: item.link,
      content_full: item.description ?? item.title,
      filed_at: resolved,
      metadata: {
        kind: 'news_article',
        rss_source: item.source,
        feed_pub_date: item.pubDate ?? null,
        canonical_pub_date: canonicalDates[i] ?? null,
      } satisfies Json,
      is_primary_source: false,
    };
  });
}

export async function fetchGdelt(
  entity: ResolvedEntity,
  opts: ArticleFetchOpts & { timeRange?: TimeRange },
): Promise<PendingDocument[]> {
  const timespanHours = opts.timeRange
    ? Math.min(Math.max(1, Math.ceil((opts.timeRange.end.getTime() - opts.timeRange.start.getTime()) / 3_600_000)), 24 * 365 * 5)
    : 24 * 30;

  const articles = await searchArticles(entity.name, {
    maxRecords: opts.maxArticles,
    timespanHours,
  });

  // GDELT's `seendate` is the crawler's first-observed time, not the
  // publication time. Same canonical-date pass we use for RSS handles
  // this — pulls article:published_time from the article page itself.
  const seenDates = articles.map(a => parseGdeltDate(a.seendate));
  const canonicalDates = await resolveCanonicalDates(articles.map(a => a.url));

  return articles.map((a, i) => {
    const resolved = reconcileArticleDate(seenDates[i], canonicalDates[i]);
    return {
      id: `gdelt-${shortHash(a.url)}`,
      source: 'gdelt',
      doc_type: 'news',
      title: a.title,
      url: a.url,
      content_full: a.title,                 // GDELT doesn't surface body text in the free tier
      filed_at: resolved,
      metadata: {
        kind: 'gdelt_article',
        domain: a.domain,
        language: a.language,
        sourcecountry: a.sourcecountry,
        gdelt_seen_date: seenDates[i] ?? null,
        canonical_pub_date: canonicalDates[i] ?? null,
      } satisfies Json,
      is_primary_source: false,
    };
  });
}

function parseGdeltDate(seendate: string): string | null {
  // GDELT format: "20260430T194500Z"
  const m = seendate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/* -------------------- FRED macro -------------------- */

export interface FredFetchOpts {
  series: MacroSeriesKey[];
  timeRange?: TimeRange;
}

export async function fetchFredMacro(opts: FredFetchOpts): Promise<PendingDocument[]> {
  if (!process.env.FRED_API_KEY) return [];

  const docs: PendingDocument[] = [];
  for (const key of opts.series) {
    const seriesId = MACRO_SERIES[key];
    try {
      const series = await fetchSeries(seriesId, {
        observationStart: opts.timeRange?.start.toISOString().slice(0, 10),
        observationEnd: opts.timeRange?.end.toISOString().slice(0, 10),
      });
      const latest = series.observations.at(-1);
      docs.push({
        id: `fred-${seriesId}`,
        source: 'fred',
        doc_type: 'macro',
        title: `${series.title} (${seriesId})`,
        url: `https://fred.stlouisfed.org/series/${seriesId}`,
        content_full: null,
        filed_at: latest?.date ?? null,
        metadata: {
          kind: 'fred_series',
          series_id: seriesId,
          units: series.units,
          frequency: series.frequency,
          observation_count: series.observations.length,
          latest_date: latest?.date ?? null,
          latest_value: latest?.value ?? null,
          observations: series.observations as unknown as Json,
        } satisfies Json,
        is_primary_source: true,
      });
    } catch {
      // Skip this series on FRED error; pipeline records it as source_error
    }
  }
  return docs;
}

/** Default macro series for an entity, based on its rough business line guess. */
export function defaultMacroSeries(entity: ResolvedEntity): MacroSeriesKey[] {
  if (entity.business_line_guess === 'dcm') return ['treasury10y', 'treasury30y', 'igOas', 'hyOas'];
  if (entity.business_line_guess === 'ecm') return ['vix', 'fedFunds'];
  if (entity.business_line_guess === 'alts') return ['fedFunds', 'cpiYoY'];
  return ['treasury10y', 'fedFunds'];
}
