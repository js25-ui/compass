/**
 * Category-level query handling.
 *
 * The chat orchestrator extracts named entities, but capital-markets users
 * often ask category questions ("what's new in ECM", "muni activity",
 * "private equity deployment"). For those, expand to a small set of proxy
 * entities that represent the category — the rest of the pipeline (resolve →
 * ingest → vector search → synthesize) runs unchanged against the proxies.
 */

export type Category = 'ecm' | 'dcm' | 'munis' | 'pe' | 'alts' | 'macro' | 'high_yield' | 'investment_grade';

export interface CategoryProxy {
  query: string;          // string passed to resolveEntity
  display: string;        // human-friendly name
}

interface CategoryDef {
  label: string;          // "Equity Capital Markets"
  patterns: RegExp[];
  proxies: CategoryProxy[];
}

const CATEGORIES: Record<Category, CategoryDef> = {
  ecm: {
    label: 'Equity Capital Markets',
    patterns: [
      /\becm\b/i,
      /\bequity capital markets?\b/i,
      /\bipos?\b/i,
      /\bfollow[- ]ons?\b/i,
      /\bsecondary offerings?\b/i,
      /\bspacs?\b/i,
    ],
    // Mix of mega-cap reference issuers + recent IPO names
    proxies: [
      { query: 'Apple', display: 'Apple Inc. (AAPL)' },
      { query: 'NVIDIA', display: 'NVIDIA (NVDA)' },
      { query: 'Reddit', display: 'Reddit (RDDT)' },
      { query: 'Klaviyo', display: 'Klaviyo (KVYO)' },
    ],
  },
  dcm: {
    label: 'Debt Capital Markets',
    patterns: [
      /\bdcm\b/i,
      /\bdebt capital markets?\b/i,
      /\bcorporate bonds?\b/i,
      /\binvestment[- ]grade\b/i,
      /\bcredit (markets?|spreads?)\b/i,
      /\bnew issue\b/i,
    ],
    proxies: [
      { query: 'Boeing', display: 'Boeing (BA)' },
      { query: 'JPMorgan', display: 'JPMorgan Chase (JPM)' },
      { query: 'Apple', display: 'Apple (AAPL) — debt issuer' },
      { query: 'Carvana', display: 'Carvana (CVNA)' },
    ],
  },
  high_yield: {
    label: 'High Yield Credit',
    patterns: [
      /\bhigh[- ]yield\b/i,
      /\bjunk bonds?\b/i,
      /\bhy (credit|bonds?|spreads?)\b/i,
    ],
    proxies: [
      { query: 'Carvana', display: 'Carvana (CVNA)' },
      { query: 'Tesla', display: 'Tesla (TSLA) — convertible/HY history' },
      { query: 'Boeing', display: 'Boeing (BA)' },
    ],
  },
  investment_grade: {
    label: 'Investment Grade Credit',
    patterns: [
      /\binvestment[- ]grade\b/i,
      /\big (credit|bonds?|spreads?)\b/i,
    ],
    proxies: [
      { query: 'Apple', display: 'Apple (AAPL)' },
      { query: 'JPMorgan', display: 'JPMorgan (JPM)' },
      { query: 'Microsoft', display: 'Microsoft (MSFT)' },
    ],
  },
  munis: {
    label: 'Municipal Bonds',
    patterns: [
      /\bmunis?\b/i,
      /\bmunicipal bonds?\b/i,
      /\bgo bonds?\b/i,
      /\btax[- ]exempt\b/i,
      /\bge?neral obligation\b/i,
    ],
    proxies: [
      { query: 'New York City', display: 'NYC GO Bonds' },
      { query: 'State of California', display: 'California GO Bonds' },
      { query: 'Metropolitan Transportation Authority', display: 'MTA Bonds' },
    ],
  },
  pe: {
    label: 'Private Equity',
    patterns: [
      /\bprivate equity\b/i,
      /\bpe (deals?|deployment|markets?)\b/i,
      /\blbos?\b/i,
      /\bbuyouts?\b/i,
      /\btake[- ]privates?\b/i,
    ],
    proxies: [
      { query: 'Blackstone', display: 'Blackstone (BX)' },
      { query: 'KKR', display: 'KKR (KKR)' },
      { query: 'Apollo', display: 'Apollo (APO)' },
    ],
  },
  alts: {
    label: 'Alternative Investments',
    patterns: [
      /\balts?\b/i,
      /\balternative investments?\b/i,
      /\bhedge funds?\b/i,
      /\binfrastructure (funds?|investing)\b/i,
      /\breal estate (funds?|investing)\b/i,
      /\bprivate credit\b/i,
    ],
    proxies: [
      { query: 'Blackstone', display: 'Blackstone (BX)' },
      { query: 'KKR', display: 'KKR (KKR)' },
      { query: 'Apollo', display: 'Apollo (APO)' },
      { query: 'Ares', display: 'Ares Management (ARES)' },
    ],
  },
  macro: {
    label: 'Macro / Rates',
    patterns: [
      /\bfed (commentary|policy|rates?)\b/i,
      /\bfomc\b/i,
      /\b(10|30)[- ]year treasury\b/i,
      /\btreasury yields?\b/i,
      /\binterest rates?\b/i,
    ],
    proxies: [
      { query: 'Apple', display: 'Apple (AAPL) — IG bellwether' },
      { query: 'JPMorgan', display: 'JPMorgan (JPM)' },
      { query: 'Boeing', display: 'Boeing (BA)' },
    ],
  },
};

export interface DetectedCategory {
  category: Category;
  label: string;
  proxies: CategoryProxy[];
}

export function detectCategory(query: string): DetectedCategory | null {
  // Score by number of matching patterns; tie-break by definition order.
  let best: { category: Category; score: number } | null = null;
  for (const [cat, def] of Object.entries(CATEGORIES) as Array<[Category, CategoryDef]>) {
    const score = def.patterns.reduce((n, re) => n + (re.test(query) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) {
      best = { category: cat, score };
    }
  }
  if (!best) return null;
  const def = CATEGORIES[best.category];
  return { category: best.category, label: def.label, proxies: def.proxies };
}
