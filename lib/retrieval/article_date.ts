/**
 * Canonical-publish-date extraction for news articles.
 *
 * RSS pubDate from aggregators (Google News, Yahoo Finance) reflects when
 * the aggregator indexed the article, NOT when the publication actually
 * went live. For syndicators (MSN re-hosting USA Today, Yahoo News
 * re-hosting Reuters, etc.) this can be days off — Compass would show
 * "Texas Roadhouse menu price article" as 2026-05-16 (when MSN
 * syndicated it) instead of the real 2026-05-12 publication.
 *
 * Fix: fetch the article page and extract the canonical published-time
 * from standard meta tags. If found AND earlier than the feed pubDate
 * by > 12 hours, prefer the canonical date. Otherwise keep the feed
 * date. Cheap timeout + concurrency cap so ingestion doesn't blow up
 * on slow pages.
 */

const USER_AGENT = process.env.SEC_USER_AGENT ?? 'Compass <noreply@example.com>';
const FETCH_TIMEOUT_MS = 4000;
const SYNDICATION_THRESHOLD_HOURS = 12;

const PUBLISHED_PATTERNS: Array<RegExp> = [
  // OpenGraph / Article schema (most common)
  /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
  // Generic published meta
  /<meta[^>]+name=["']published["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["']publish[-_]?date["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)["']/i,
  // DublinCore
  /<meta[^>]+name=["']dc\.date["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["']dc\.date\.issued["'][^>]+content=["']([^"']+)["']/i,
  // JSON-LD datePublished (cheap regex; full schema parse would be heavier)
  /"datePublished"\s*:\s*"([^"]+)"/i,
  // <time pubdate datetime="...">
  /<time[^>]+pubdate[^>]+datetime=["']([^"']+)["']/i,
  /<time[^>]+datetime=["']([^"']+)["'][^>]+pubdate/i,
];

/**
 * Best-effort fetch of an article's true publish date. Returns ISO string
 * or null. Never throws — callers fall back to the feed's pubDate.
 */
export async function fetchCanonicalPublishedDate(url: string): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    // Cap the body read so we don't pull megabytes for a 50-char meta tag.
    // Meta tags live in <head> — first 100KB is plenty.
    const text = await readBoundedText(res, 100_000);
    return extractPublishedDate(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const decoder = new TextDecoder();
  let collected = '';
  let bytesRead = 0;
  while (bytesRead < maxBytes) {
    const { value, done } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    collected += decoder.decode(value, { stream: true });
    // Bail as soon as we've seen </head> — published-time is always there.
    if (collected.includes('</head>') || collected.includes('</HEAD>')) break;
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  return collected;
}

/**
 * Try every meta-tag pattern in order. Returns the first parseable ISO
 * date found, or null.
 */
export function extractPublishedDate(html: string): string | null {
  // Trim to <head> when possible — avoids picking up datePublished from
  // an embedded comment thread or related-articles widget in the body.
  const headEnd = html.search(/<\/head>/i);
  const search = headEnd > 0 ? html.slice(0, headEnd + 7) : html.slice(0, 100_000);
  for (const re of PUBLISHED_PATTERNS) {
    const m = search.match(re);
    if (!m) continue;
    const iso = normalizeIso(m[1]);
    if (iso) return iso;
  }
  return null;
}

function normalizeIso(raw: string): string | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;
  const d = new Date(cleaned);
  if (Number.isNaN(d.getTime())) return null;
  // Reject obvious garbage: too far in past (pre-2000) or future (>1y out).
  const yr = d.getUTCFullYear();
  if (yr < 2000 || yr > new Date().getUTCFullYear() + 1) return null;
  return d.toISOString();
}

/**
 * Resolve final article date given the feed-reported date + (best-effort)
 * canonical date. Rule: prefer canonical when it's meaningfully earlier
 * than the feed date (indicating the feed reported a syndication time
 * for a re-hosted article). Otherwise keep the feed date.
 *
 * Never returns the ingestion timestamp — when both inputs are null,
 * returns null. A wrong date is worse than an absent one.
 */
export function reconcileArticleDate(feedDateIso: string | null, canonicalIso: string | null): string | null {
  if (!canonicalIso && !feedDateIso) return null;
  if (!canonicalIso) return feedDateIso;
  if (!feedDateIso) return canonicalIso;
  const feedMs = Date.parse(feedDateIso);
  const canMs = Date.parse(canonicalIso);
  if (!Number.isFinite(feedMs) || !Number.isFinite(canMs)) return feedDateIso ?? canonicalIso;
  // Canonical only wins if earlier by > threshold (otherwise small clock-
  // skew differences would flip dates around the syndication date).
  const deltaH = (feedMs - canMs) / (1000 * 60 * 60);
  return deltaH > SYNDICATION_THRESHOLD_HOURS ? canonicalIso : feedDateIso;
}

/**
 * Resolve canonical dates for many articles in parallel, capped concurrency.
 * Returns an array aligned with `urls` — entries are ISO strings or null.
 */
export async function resolveCanonicalDates(urls: Array<string | null>, concurrency = 5): Promise<Array<string | null>> {
  const results: Array<string | null> = new Array(urls.length).fill(null);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= urls.length) return;
      const u = urls[i];
      if (!u) continue;
      results[i] = await fetchCanonicalPublishedDate(u);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
  return results;
}
