const SEC_USER_AGENT = process.env.SEC_USER_AGENT ?? 'Compass <noreply@example.com>';
const EDGAR_BASE = 'https://data.sec.gov';
const EDGAR_ARCHIVE = 'https://www.sec.gov/Archives/edgar/data';

export interface EdgarFiling {
  accessionNumber: string;     // e.g. "0000320193-24-000123"
  formType: string;            // '10-K' | '10-Q' | '8-K' | 'S-1' | etc.
  filedAt: string;             // ISO date "2024-11-01"
  primaryDocument: string;     // e.g. "aapl-20240928.htm"
  primaryDocumentUrl: string;  // full URL
  reportDate: string | null;
  size: number | null;
}

interface FilingsRecentResponse {
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      form: string[];
      primaryDocument: string[];
      size: number[];
    };
  };
}

const TARGET_FORMS = new Set([
  '10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '8-K/A', 'S-1', 'S-1/A', '20-F', '6-K', '40-F', 'DEF 14A',
]);

function unpadCik(cik: string): string {
  return String(parseInt(cik, 10));
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`EDGAR request failed (${res.status}): ${url}`);
  }
  return (await res.json()) as T;
}

/** List recent filings for a CIK (zero-padded 10-digit). Filters to common form types. */
export async function listFilings(cik: string, opts: { limit?: number; forms?: string[] } = {}): Promise<EdgarFiling[]> {
  const padded = cik.padStart(10, '0');
  const url = `${EDGAR_BASE}/submissions/CIK${padded}.json`;
  const data = await fetchJson<FilingsRecentResponse>(url);

  const recent = data.filings.recent;
  const allowed = new Set(opts.forms ?? Array.from(TARGET_FORMS));
  const limit = opts.limit ?? 20;

  const filings: EdgarFiling[] = [];
  for (let i = 0; i < recent.accessionNumber.length && filings.length < limit; i++) {
    const form = recent.form[i];
    if (!allowed.has(form)) continue;
    const accession = recent.accessionNumber[i];
    const accessionNoDash = accession.replace(/-/g, '');
    const primaryDocument = recent.primaryDocument[i];
    filings.push({
      accessionNumber: accession,
      formType: form,
      filedAt: recent.filingDate[i],
      reportDate: recent.reportDate[i] || null,
      primaryDocument,
      primaryDocumentUrl: `${EDGAR_ARCHIVE}/${unpadCik(padded)}/${accessionNoDash}/${primaryDocument}`,
      size: recent.size[i] ?? null,
    });
  }

  return filings;
}

/** Fetch the primary document and strip HTML to plain text. */
export async function fetchFilingText(filing: EdgarFiling): Promise<string> {
  const res = await fetch(filing.primaryDocumentUrl, {
    headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'text/html,*/*' },
  });
  if (!res.ok) {
    throw new Error(`EDGAR document fetch failed (${res.status}): ${filing.primaryDocumentUrl}`);
  }
  const html = await res.text();
  return stripHtml(html);
}

/** Conservative HTML→text: strip script/style, decode entities, collapse whitespace. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
