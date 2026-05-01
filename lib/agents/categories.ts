/**
 * Category-level query handling.
 *
 * Capital-markets users routinely ask category questions ("what's new in ECM",
 * "muni activity", "private equity deployment"). The deterministic part is
 * just *recognizing* that the query is about a category — the actual list of
 * representative issuers comes from Haiku at query time so it stays fresh and
 * grounded in the model's current view of the market, not a static list.
 */

import { haikuComplete } from '@/lib/llm/anthropic';

export type Category =
  | 'ecm' | 'dcm' | 'munis' | 'pe' | 'alts' | 'macro' | 'high_yield' | 'investment_grade';

interface CategoryDef {
  label: string;
  patterns: RegExp[];
  /** Brief description used to brief Haiku when it picks proxies. */
  scope: string;
}

const CATEGORIES: Record<Category, CategoryDef> = {
  ecm: {
    label: 'Equity Capital Markets',
    patterns: [
      /\becm\b/i, /\bequity capital markets?\b/i,
      /\bipos?\b/i, /\bfollow[- ]ons?\b/i,
      /\bsecondary offerings?\b/i, /\bspacs?\b/i,
    ],
    scope: 'IPOs, follow-on offerings, secondaries, equity issuance, primary equity markets',
  },
  dcm: {
    label: 'Debt Capital Markets',
    patterns: [
      /\bdcm\b/i, /\bdebt capital markets?\b/i,
      /\bcorporate bonds?\b/i, /\bcredit (markets?|spreads?)\b/i,
      /\bnew issue\b/i,
    ],
    scope: 'corporate bond issuance, IG and HY credit markets, new-issue activity, debt offerings',
  },
  high_yield: {
    label: 'High Yield Credit',
    patterns: [
      /\bhigh[- ]yield\b/i, /\bjunk bonds?\b/i,
      /\bhy (credit|bonds?|spreads?)\b/i,
    ],
    scope: 'high-yield / junk bond market, sub-IG corporate credit, default rates, distressed names',
  },
  investment_grade: {
    label: 'Investment Grade Credit',
    patterns: [/\binvestment[- ]grade\b/i, /\big (credit|bonds?|spreads?)\b/i],
    scope: 'investment-grade corporate credit, IG OAS, mega-cap issuers',
  },
  munis: {
    label: 'Municipal Bonds',
    patterns: [
      /\bmunis?\b/i, /\bmunicipal bonds?\b/i, /\bgo bonds?\b/i,
      /\btax[- ]exempt\b/i, /\bge?neral obligation\b/i,
    ],
    scope: 'US municipal bonds, GO bonds, tax-exempt issuance, state and city financing',
  },
  pe: {
    label: 'Private Equity',
    patterns: [
      /\bprivate equity\b/i, /\bpe (deals?|deployment|markets?)\b/i,
      /\blbos?\b/i, /\bbuyouts?\b/i, /\btake[- ]privates?\b/i,
    ],
    scope: 'private equity, LBOs, take-privates, sponsor deployment, fund activity',
  },
  alts: {
    label: 'Alternative Investments',
    patterns: [
      /\balts?\b/i, /\balternative investments?\b/i,
      /\bhedge funds?\b/i, /\binfrastructure (funds?|investing)\b/i,
      /\breal estate (funds?|investing)\b/i, /\bprivate credit\b/i,
    ],
    scope: 'alternatives broadly: PE, hedge funds, infrastructure, real estate, private credit',
  },
  macro: {
    label: 'Macro / Rates',
    patterns: [
      /\bfed (commentary|policy|rates?)\b/i, /\bfomc\b/i,
      /\b(10|30)[- ]year treasury\b/i, /\btreasury yields?\b/i,
      /\binterest rates?\b/i,
    ],
    scope: 'macro / rates / Fed policy / Treasury yields / FOMC',
  },
};

export interface DetectedCategory {
  category: Category;
  label: string;
  scope: string;
}

export function detectCategory(query: string): DetectedCategory | null {
  let best: { category: Category; score: number } | null = null;
  for (const [cat, def] of Object.entries(CATEGORIES) as Array<[Category, CategoryDef]>) {
    const score = def.patterns.reduce((n, re) => n + (re.test(query) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) {
      best = { category: cat, score };
    }
  }
  if (!best) return null;
  const def = CATEGORIES[best.category];
  return { category: best.category, label: def.label, scope: def.scope };
}

/**
 * Ask Haiku to suggest 3-4 representative issuers / securities for the
 * detected category, grounded in the user's actual question. No hardcoded
 * list — the model picks names that match the query intent each time.
 */
export async function suggestProxies(
  query: string,
  category: DetectedCategory,
): Promise<string[]> {
  const systemPrompt = `You suggest representative entities for capital-markets category queries.

Given a user query about ${category.label} (${category.scope}), return 3-4 specific entities (US-listed companies, well-known sovereigns, US states/cities, or named private companies) that are the most relevant grounded examples to look up news for.

Output STRICT JSON only, no prose:
{"entities": ["Name 1", "Name 2", "Name 3"]}

Rules:
- Pick the entities most likely to have news activity in the category right now.
- Prefer common-stock tickers or full company names that the SEC EDGAR ticker file recognizes.
- For munis: name a US city or state (e.g. "New York City", "State of California"), not a generic "muni issuer".
- For sovereigns: name the country (e.g. "United States Treasury", "Mexico").
- For PE / Alts: name the firm (Blackstone, KKR, Apollo, etc.).
- Output 3-4 entities, never more.`;

  let raw: string;
  try {
    raw = await haikuComplete({ systemPrompt, userMessage: query, maxTokens: 200 });
  } catch {
    return [];
  }
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as { entities?: unknown };
    if (Array.isArray(parsed.entities)) {
      return parsed.entities.filter((e): e is string => typeof e === 'string').slice(0, 4);
    }
    return [];
  } catch {
    return [];
  }
}
