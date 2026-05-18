/**
 * Fallback ticker → CIK lookup via SEC EDGAR full-text search.
 *
 * SEC's `company_tickers.json` (loaded by sec_tickers.ts) is the cheap
 * primary source but isn't exhaustive — it omits issuers who've filed
 * Form 15 to begin deregistration (e.g. Confluent CFLT, filed 2026-03-27),
 * even though those issuers can still have valid recent 10-Ks/10-Qs and
 * full XBRL data available. Without a fallback, the trading-comps engine
 * drops these as "ticker not found" when they're actually fine peers.
 *
 * This helper queries EDGAR's full-text search index for a ticker token
 * and matches its appearance inside a display_name of the form
 * "Issuer Name  (TICKER)  (CIK NNNNNNNNNN)". One HTTP request per
 * unknown ticker; results are cached in-process.
 */

const USER_AGENT = process.env.SEC_USER_AGENT ?? 'Compass <noreply@example.com>';
const EDGAR_SEARCH = 'https://efts.sec.gov/LATEST/search-index';
const FETCH_TIMEOUT_MS = 4000;

const cache = new Map<string, { cik: string; name: string } | null>();

interface SearchHit {
  _source?: {
    display_names?: string[];
    ciks?: string[];
  };
}

interface SearchResponse {
  hits?: { hits?: SearchHit[] };
}

/**
 * Resolve a ticker symbol to {cik, name} via EDGAR full-text search.
 * Returns null on any failure (no hits, network error, parse error,
 * ambiguous result). Callers should treat this as a best-effort fallback,
 * not a primary source.
 */
export async function findCikByTickerViaEdgarSearch(ticker: string): Promise<{ cik: string; name: string } | null> {
  const t = ticker.trim().toUpperCase().replace(/^\$/, '');
  if (!/^[A-Z][A-Z.\-]{0,5}$/.test(t)) return null;
  if (cache.has(t)) return cache.get(t)!;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Search 10-K filings — every active US issuer files one at least
    // annually. Quoting the ticker biases toward issuer-name matches
    // ("Confluent, Inc.  (CFLT)") rather than coincidental text.
    const url = `${EDGAR_SEARCH}?q=%22${encodeURIComponent(t)}%22&forms=10-K`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) { cache.set(t, null); return null; }
    const body = (await res.json()) as SearchResponse;
    const hits = body.hits?.hits ?? [];

    // Look for a display_name containing "(TICKER)" verbatim. The first
    // such hit wins — search results are ordered by relevance and an
    // exact ticker match in the issuer's name is the strongest signal.
    const tickerRe = new RegExp(`\\(${t}\\)`);
    for (const h of hits) {
      const names = h._source?.display_names ?? [];
      const ciks = h._source?.ciks ?? [];
      if (ciks.length === 0) continue;
      for (const name of names) {
        if (tickerRe.test(name)) {
          const cik = padCik(ciks[0]);
          // Strip the "  (TICKER)  (CIK XXX)" suffix for a clean name.
          const cleanName = name.replace(/\s*\([A-Z.\-]+\)\s*\(CIK \d+\)\s*$/, '').trim();
          const result = { cik, name: cleanName };
          cache.set(t, result);
          return result;
        }
      }
    }
    cache.set(t, null);
    return null;
  } catch {
    cache.set(t, null);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function padCik(cik: string): string {
  return String(cik).padStart(10, '0');
}
