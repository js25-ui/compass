/**
 * Cheap pattern-based query-intent classifier. No LLM call — runs in <1ms.
 *
 * Intents are mutually exclusive only nominally — a query like "what's
 * Snowflake's revenue strategy" mentions both 'revenue' (financial_metric)
 * and 'strategy' (qualitative_strategic). We pick the dominant intent by
 * keyword hit-count, breaking ties toward financial_metric since that's the
 * intent where retrieval routing has the largest measurable improvement.
 */

export type QueryIntent = 'financial_metric' | 'qualitative_strategic' | 'events' | 'general';

// Keyword sets. Tuned to be high-recall on common analyst phrasings.
const FINANCIAL_KEYWORDS: RegExp[] = [
  /\brevenue\b/i,
  /\bsales\b/i,
  /\bebitda\b/i,
  /\boperating income\b/i,
  /\bnet income\b/i,
  /\bgross (?:profit|margin)\b/i,
  /\boperating margin\b/i,
  /\bnet margin\b/i,
  /\bearnings\b/i,
  /\beps\b/i,
  /\bcash flow\b/i,
  /\bfcf\b/i,
  /\bfree cash flow\b/i,
  /\bcapex\b/i,
  /\bcapital expenditure\b/i,
  /\bdebt\b/i,
  /\bleverage\b/i,
  /\binterest expense\b/i,
  /\bguidance\b/i,
  /\bgrowth\b/i,
  /\bretention\b/i,
  /\bnrr\b/i,
  /\barr\b/i,
  /\bmrr\b/i,
  /\bdeferred revenue\b/i,
  /\brpo\b/i,
  /\bremaining performance obligations\b/i,
  /\bcogs\b/i,
  /\bgross profit\b/i,
  /\bbacklog\b/i,
  /\bproduct revenue\b/i,
  /\brecurring revenue\b/i,
  /\bnumbers?\b/i,
  /\bmetrics?\b/i,
  /\bfinancials?\b/i,
  /\bquarter(?:ly)?\b/i,
  /\blatest (?:quarter|results)\b/i,
  /\blast (?:quarter|year)\b/i,
  /\bq[1-4]\b/i,
  /\bfy\s*\d{2,4}\b/i,
];

const QUALITATIVE_KEYWORDS: RegExp[] = [
  /\bstrategy\b/i,
  /\bstrategic\b/i,
  /\bpositioning\b/i,
  /\bcompetiti(?:ve|on|or)\b/i,
  /\bmoat\b/i,
  /\brisk(?:s|y)?\b/i,
  /\boutlook\b/i,
  /\bthesis\b/i,
  /\bopportunit(?:y|ies)\b/i,
  /\bnarrative\b/i,
  /\bdifferentiation\b/i,
  /\bmarket position\b/i,
  /\bbusiness model\b/i,
  /\bmoats?\b/i,
];

const EVENTS_KEYWORDS: RegExp[] = [
  /\bacquisition\b/i,
  /\bacquire(?:d|s|r)?\b/i,
  /\bmerg(?:er|ed|es|ing)\b/i,
  /\blaunch(?:ed|es|ing)?\b/i,
  /\bannounc(?:e|ed|es|ement)\b/i,
  /\bpartnership\b/i,
  /\bdeal\b/i,
  /\bspin[- ]?off\b/i,
  /\bipo\b/i,
  /\bsecondary offering\b/i,
  /\btender offer\b/i,
  /\bdivest\b/i,
  /\brestructur(?:e|ing)\b/i,
  /\blayoff\b/i,
  /\bappointed?\b/i,
  /\bresigne?d?\b/i,
  /\bbankrupt(?:cy)?\b/i,
];

export interface IntentScore {
  intent: QueryIntent;
  /** Number of distinct keyword patterns that matched. */
  hits: number;
  /** The dominant intent — written separately so callers don't have to
   *  re-derive it from intent+hits. */
}

export function classifyQueryIntent(query: string): { intent: QueryIntent; reason: string } {
  const finHits = countHits(query, FINANCIAL_KEYWORDS);
  const qualHits = countHits(query, QUALITATIVE_KEYWORDS);
  const evtHits = countHits(query, EVENTS_KEYWORDS);

  if (finHits === 0 && qualHits === 0 && evtHits === 0) {
    return { intent: 'general', reason: 'no intent keywords matched' };
  }

  // Tie-break toward financial_metric — that's the intent where the
  // boilerplate-vs-statement-table problem is biggest, so we'd rather
  // false-positive into it than miss it. Then qualitative, then events.
  const max = Math.max(finHits, qualHits, evtHits);
  if (finHits === max) {
    return { intent: 'financial_metric', reason: `${finHits} financial keyword(s)` };
  }
  if (qualHits === max) {
    return { intent: 'qualitative_strategic', reason: `${qualHits} qualitative keyword(s)` };
  }
  return { intent: 'events', reason: `${evtHits} event keyword(s)` };
}

function countHits(text: string, patterns: RegExp[]): number {
  let hits = 0;
  for (const p of patterns) {
    if (p.test(text)) hits += 1;
  }
  return hits;
}

/**
 * For pure-quantitative metric questions, surface specific metric mentions
 * so the chat agent can route to the XBRL financial_facts table directly
 * before falling back to chunk retrieval. Returns the recognized metrics
 * mapped to their canonical FactMetric key in financial_facts.
 *
 * Stays a thin keyword mapping — the chat agent decides whether to call
 * lookup_facts based on whether this returns any entries.
 */
const METRIC_TO_FACT: Array<{ pattern: RegExp; metric: string }> = [
  { pattern: /\brevenue\b/i,            metric: 'revenue' },
  { pattern: /\bsales\b/i,              metric: 'revenue' },
  { pattern: /\bnet income\b/i,         metric: 'net_income' },
  { pattern: /\bearnings\b/i,           metric: 'net_income' },
  { pattern: /\bebitda\b/i,             metric: 'ebitda' },
  { pattern: /\boperating income\b/i,   metric: 'operating_income' },
  { pattern: /\bgross profit\b/i,       metric: 'gross_profit' },
  { pattern: /\bcapex\b/i,              metric: 'capex' },
  { pattern: /\blong[- ]term debt\b/i,  metric: 'long_term_debt' },
  { pattern: /\btotal assets\b/i,       metric: 'total_assets' },
  { pattern: /\btotal liabilities\b/i,  metric: 'total_liabilities' },
  { pattern: /\bcash\s+(?:and equivalents|on hand)\b/i, metric: 'cash_and_equivalents' },
  { pattern: /\bshares outstanding\b/i, metric: 'shares_outstanding' },
];

export function detectFactsLookup(query: string): string[] {
  const found = new Set<string>();
  for (const { pattern, metric } of METRIC_TO_FACT) {
    if (pattern.test(query)) found.add(metric);
  }
  return Array.from(found);
}
