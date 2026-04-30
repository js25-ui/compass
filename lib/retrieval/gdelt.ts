const GDELT_DOC = 'https://api.gdeltproject.org/api/v2/doc/doc';

// GDELT rate limit: 1 request per 5 seconds, no auth.
let lastCallAt = 0;
const MIN_INTERVAL_MS = 5_000;

async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastCallAt;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  lastCallAt = Date.now();
}

export interface GdeltArticle {
  url: string;
  title: string;
  seendate: string;          // "20260430T140000Z"
  domain: string;
  language: string;
  sourcecountry: string;
  socialimage: string | null;
}

interface GdeltResponse {
  articles?: GdeltArticle[];
  status?: string;
}

/** Search GDELT DOC 2.0 for recent articles matching the query. Free, no key. */
export async function searchArticles(
  query: string,
  opts: { maxRecords?: number; timespanHours?: number } = {},
): Promise<GdeltArticle[]> {
  const max = Math.min(opts.maxRecords ?? 25, 250);
  const timespan = opts.timespanHours ?? 24 * 30; // default last 30 days

  const params = new URLSearchParams({
    query: `"${query}" sourcecountry:US`,
    mode: 'ArtList',
    format: 'json',
    maxrecords: String(max),
    timespan: `${timespan}h`,
    sort: 'datedesc',
  });

  await throttle();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`${GDELT_DOC}?${params}`, {
      headers: { 'User-Agent': process.env.SEC_USER_AGENT ?? 'Compass <noreply@example.com>' },
      signal: controller.signal,
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, MIN_INTERVAL_MS));
    return [];
  }
  if (!res.ok) return [];

  // GDELT returns plain text "Error" pages with a 200 status sometimes; guard the JSON parse.
  const text = await res.text();
  if (!text || !text.trim().startsWith('{')) return [];
  let parsed: GdeltResponse;
  try {
    parsed = JSON.parse(text) as GdeltResponse;
  } catch {
    return [];
  }
  return parsed.articles ?? [];
}
