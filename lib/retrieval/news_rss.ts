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

  return dedupeByLink(items)
    .sort((a, b) => (parseDate(b.pubDate) ?? 0) - (parseDate(a.pubDate) ?? 0));
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
