export interface RssItem {
  title: string;
  link: string;
  pubDate: string | null;     // ISO if parseable, else original string
  source: string;
  description: string | null;
}

const USER_AGENT = process.env.SEC_USER_AGENT ?? 'Compass <noreply@example.com>';

/**
 * Fetch news items for an entity. Aggregates Yahoo Finance per-ticker RSS
 * (tickers only) plus Google News query RSS (all entities).
 */
export async function fetchNewsForEntity(opts: {
  ticker?: string;
  query: string;             // free-text query, e.g. "Boeing"
}): Promise<RssItem[]> {
  const tasks: Promise<RssItem[]>[] = [
    fetchGoogleNews(opts.query),
  ];
  if (opts.ticker) tasks.push(fetchYahooFinance(opts.ticker));

  const results = await Promise.allSettled(tasks);
  const items: RssItem[] = [];
  for (const r of results) if (r.status === 'fulfilled') items.push(...r.value);

  // First dedupe by exact link (cheap; catches identical re-postings).
  // Then dedupe by normalized title — when the same story appears in both
  // Yahoo Finance (direct URL, canonical date fetchable) and Google News
  // (opaque redirect URL whose pubDate is the aggregator's index time),
  // keep the direct-URL version. Avoids the syndication-date problem
  // without needing to crack Google News' redirect encoding.
  const byLink = dedupeByLink(items);
  const byTitle = dedupeByNormalizedTitle(byLink);
  return byTitle.sort((a, b) => (parseDate(b.pubDate) ?? 0) - (parseDate(a.pubDate) ?? 0));
}

async function fetchYahooFinance(ticker: string): Promise<RssItem[]> {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
  return fetchAndParseRss(url, 'Yahoo Finance');
}

async function fetchGoogleNews(query: string): Promise<RssItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  return fetchAndParseRss(url, 'Google News');
}

async function fetchAndParseRss(url: string, source: string): Promise<RssItem[]> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRss(xml, source);
  } catch {
    return [];
  }
}

function parseRss(xml: string, source: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1];
    items.push({
      title: extract(block, 'title') ?? '',
      link: extract(block, 'link') ?? '',
      pubDate: normalizeDate(extract(block, 'pubDate')),
      description: extract(block, 'description'),
      source,
    });
  }
  return items.filter(i => i.title && i.link);
}

function extract(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();
}

function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString();
}

function parseDate(value: string | null): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

function dedupeByLink(items: RssItem[]): RssItem[] {
  const seen = new Set<string>();
  const out: RssItem[] = [];
  for (const i of items) {
    if (seen.has(i.link)) continue;
    seen.add(i.link);
    out.push(i);
  }
  return out;
}

/**
 * Strip the trailing publisher suffix Google News appends to titles
 * ("- USA Today", "- MSN", "- Yahoo Finance"), lowercase, collapse
 * whitespace, remove punctuation. Two articles about the same story
 * from different feeds end up with the same normalized key even though
 * one says "Texas Roadhouse increases menu prices amid inflation -
 * USA Today" and the other "Texas Roadhouse increases menu prices
 * amid inflation - MSN".
 */
function normalizeTitle(title: string): string {
  let t = title.trim();
  // Drop " - Publisher" trailing suffix that Google News appends.
  const dashIdx = t.lastIndexOf(' - ');
  if (dashIdx > 20 && dashIdx > t.length - 60) {
    t = t.slice(0, dashIdx);
  }
  return t
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[‘’“”]/g, "'")         // curly quotes
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DIRECT_URL_HOSTS = new Set([
  'finance.yahoo.com',
  'www.yahoo.com',
  'www.fool.com',
  'www.reuters.com',
  'www.bloomberg.com',
  'www.cnbc.com',
  'www.wsj.com',
  'www.ft.com',
  'seekingalpha.com',
  'www.marketwatch.com',
  'www.barrons.com',
  'www.businesswire.com',
  'www.prnewswire.com',
]);

/** Higher score = better-quality URL to keep when titles collide. */
function urlQualityScore(url: string): number {
  try {
    const u = new URL(url);
    // Google News intermediates are opaque protobuf redirects — worst.
    if (u.hostname === 'news.google.com') return 0;
    // Known direct publishers — best.
    if (DIRECT_URL_HOSTS.has(u.hostname)) return 3;
    // Direct-looking URL (article path with words, not just a token) — good.
    if (/\/(20\d{2}|article|news|story|m|p)\//.test(u.pathname) || u.pathname.length > 30) return 2;
    return 1;
  } catch {
    return 0;
  }
}

/**
 * Group by normalized title and keep ONE representative per group.
 * Preference (in order):
 *   1. Higher urlQualityScore (direct publisher > Google News redirect)
 *   2. Earlier pubDate (closer to original publication when both are direct)
 */
function dedupeByNormalizedTitle(items: RssItem[]): RssItem[] {
  const byKey = new Map<string, RssItem>();
  for (const item of items) {
    const key = normalizeTitle(item.title);
    if (!key) {
      byKey.set(item.link, item);   // can't normalize — keep verbatim
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    const existingScore = urlQualityScore(existing.link);
    const candidateScore = urlQualityScore(item.link);
    if (candidateScore > existingScore) {
      byKey.set(key, item);
      continue;
    }
    if (candidateScore === existingScore) {
      // Tie on URL quality — prefer the earlier pubDate (closer to original).
      const existingMs = parseDate(existing.pubDate) ?? Infinity;
      const candidateMs = parseDate(item.pubDate) ?? Infinity;
      if (candidateMs < existingMs) byKey.set(key, item);
    }
  }
  return [...byKey.values()];
}
