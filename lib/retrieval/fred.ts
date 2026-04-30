const FRED_BASE = 'https://api.stlouisfed.org/fred';

export interface FredObservation {
  date: string;       // ISO "YYYY-MM-DD"
  value: number | null;
}

export interface FredSeries {
  id: string;
  title: string;
  units: string;
  frequency: string;
  observations: FredObservation[];
}

interface FredSeriesInfoResponse {
  seriess: Array<{ id: string; title: string; units: string; frequency: string }>;
}

interface FredObservationsResponse {
  observations: Array<{ date: string; value: string }>;
}

function fredKey(): string {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error('FRED_API_KEY is not set');
  return key;
}

export interface FetchSeriesOptions {
  /** ISO date "YYYY-MM-DD". Defaults to one year ago. */
  observationStart?: string;
  /** ISO date "YYYY-MM-DD". Defaults to today. */
  observationEnd?: string;
  limit?: number;
}

/** Fetch a single FRED series by ID with recent observations (default last 1y). */
export async function fetchSeries(seriesId: string, opts: FetchSeriesOptions = {}): Promise<FredSeries> {
  const apiKey = fredKey();
  const start = opts.observationStart ?? oneYearAgoIso();
  const end = opts.observationEnd ?? new Date().toISOString().slice(0, 10);
  const limit = opts.limit ?? 100_000;

  const obsUrl = new URL(`${FRED_BASE}/series/observations`);
  obsUrl.searchParams.set('series_id', seriesId);
  obsUrl.searchParams.set('observation_start', start);
  obsUrl.searchParams.set('observation_end', end);
  obsUrl.searchParams.set('limit', String(limit));
  obsUrl.searchParams.set('sort_order', 'asc');
  obsUrl.searchParams.set('api_key', apiKey);
  obsUrl.searchParams.set('file_type', 'json');

  const [info, obs] = await Promise.all([
    fetchJson<FredSeriesInfoResponse>(
      `${FRED_BASE}/series?series_id=${encodeURIComponent(seriesId)}&api_key=${apiKey}&file_type=json`,
    ),
    fetchJson<FredObservationsResponse>(obsUrl.toString()),
  ]);

  if (!info.seriess?.[0]) throw new Error(`FRED series not found: ${seriesId}`);
  const meta = info.seriess[0];

  return {
    id: meta.id,
    title: meta.title,
    units: meta.units,
    frequency: meta.frequency,
    observations: obs.observations.map(o => ({
      date: o.date,
      value: o.value === '.' ? null : Number(o.value),
    })),
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`FRED request failed (${res.status}): ${url.split('?')[0]}`);
  }
  return (await res.json()) as T;
}

function oneYearAgoIso(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

/** Common macro series referenced by the Macro Agent. */
export const MACRO_SERIES = {
  treasury10y: 'DGS10',
  treasury30y: 'DGS30',
  fedFunds: 'DFF',
  vix: 'VIXCLS',
  igOas: 'BAMLC0A0CM',
  hyOas: 'BAMLH0A0HYM2',
  cpiYoY: 'CPIAUCSL',
} as const;

export type MacroSeriesKey = keyof typeof MACRO_SERIES;
