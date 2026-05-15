/**
 * SEC filing section detector.
 *
 * Maps a position in the stripped-text of a 10-Q / 10-K / 8-K to the section
 * that contains it (Income Statement, MD&A, Risk Factors, Cover Page, etc.).
 * Used by the chunker to tag chunks at ingest time, and by retrieval to
 * detect the section of legacy untagged chunks at query time.
 *
 * Detection is regex-based — section headers in SEC filings are highly
 * canonical (Item 2., Item 1A., Condensed Consolidated Statements of
 * Operations, FORWARD-LOOKING STATEMENTS, etc.). For a chunk whose start
 * position lies between two section headers, the section is the latest
 * header before the start.
 */

export type SectionTag =
  | 'cover_page'
  | 'table_of_contents'
  | 'forward_looking'
  | 'income_statement'
  | 'balance_sheet'
  | 'cash_flow'
  | 'equity_statement'
  | 'notes'
  | 'mdna'
  | 'market_risk'
  | 'controls_procedures'
  | 'risk_factors'
  | 'legal_proceedings'
  | 'other_information'
  | 'signatures'
  | 'exhibits'
  | 'eight_k_item'
  | 'news_body'
  | 'unknown';

/** Section weight by query intent — used by the retrieval re-ranker.
 *  >1.0 boosts, <1.0 penalizes, 1.0 is neutral. */
export interface SectionWeights {
  financial_metric: number;
  qualitative_strategic: number;
  events: number;
  general: number;
}

export const SECTION_WEIGHTS: Record<SectionTag, SectionWeights> = {
  income_statement:    { financial_metric: 1.60, qualitative_strategic: 0.95, events: 1.00, general: 1.10 },
  cash_flow:           { financial_metric: 1.45, qualitative_strategic: 0.95, events: 1.00, general: 1.05 },
  balance_sheet:       { financial_metric: 1.40, qualitative_strategic: 0.95, events: 1.00, general: 1.00 },
  equity_statement:    { financial_metric: 1.15, qualitative_strategic: 0.95, events: 1.00, general: 1.00 },
  notes:               { financial_metric: 1.30, qualitative_strategic: 1.05, events: 1.10, general: 1.00 },
  mdna:                { financial_metric: 1.40, qualitative_strategic: 1.50, events: 1.20, general: 1.20 },
  market_risk:         { financial_metric: 1.10, qualitative_strategic: 1.20, events: 1.00, general: 1.00 },
  risk_factors:        { financial_metric: 0.85, qualitative_strategic: 1.50, events: 1.05, general: 1.00 },
  legal_proceedings:   { financial_metric: 0.85, qualitative_strategic: 1.10, events: 1.40, general: 1.00 },
  other_information:   { financial_metric: 0.85, qualitative_strategic: 1.00, events: 1.10, general: 0.95 },
  controls_procedures: { financial_metric: 0.60, qualitative_strategic: 0.85, events: 0.80, general: 0.85 },
  forward_looking:     { financial_metric: 0.35, qualitative_strategic: 0.55, events: 0.65, general: 0.65 },
  table_of_contents:   { financial_metric: 0.20, qualitative_strategic: 0.30, events: 0.30, general: 0.40 },
  cover_page:          { financial_metric: 0.25, qualitative_strategic: 0.35, events: 0.40, general: 0.50 },
  signatures:          { financial_metric: 0.30, qualitative_strategic: 0.40, events: 0.40, general: 0.50 },
  exhibits:            { financial_metric: 0.50, qualitative_strategic: 0.60, events: 0.70, general: 0.70 },
  eight_k_item:        { financial_metric: 1.15, qualitative_strategic: 1.10, events: 1.50, general: 1.15 },
  news_body:           { financial_metric: 1.10, qualitative_strategic: 1.10, events: 1.15, general: 1.10 },
  unknown:             { financial_metric: 1.00, qualitative_strategic: 1.00, events: 1.00, general: 1.00 },
};

interface SectionPattern {
  tag: SectionTag;
  /** Match the heading text. Anchored to a word boundary to avoid catching
   *  intra-paragraph mentions ("the forward-looking statements above…"). */
  patterns: RegExp[];
  /** Priority when multiple patterns hit the same position — higher wins.
   *  Used to disambiguate "PART I" preamble vs the Item it contains. */
  priority: number;
}

/**
 * Order matters only for `priority` ties — for the same character position,
 * the higher-priority tag is preferred. The detector iterates ALL patterns
 * over the whole text and merges marker lists.
 */
const SECTION_PATTERNS: SectionPattern[] = [
  // --- 10-Q / 10-K boilerplate ---
  // Cover page: typically the first ~1500 chars containing SEC + form id
  // headers. Not a regex match — assigned positionally below.
  {
    tag: 'table_of_contents',
    patterns: [/\bTABLE OF CONTENTS\b/g],
    priority: 5,
  },
  {
    tag: 'forward_looking',
    patterns: [
      /\b(?:CAUTIONARY NOTE REGARDING |SPECIAL NOTE REGARDING |NOTE REGARDING )?FORWARD[\s-]LOOKING STATEMENTS\b/gi,
      /\bSAFE HARBOR (?:STATEMENT|PROVISIONS?)\b/gi,
    ],
    priority: 6,
  },
  // --- 10-Q financial-statement subsections (Item 1 contents) ---
  // Match the canonical heading lines. SEC filings consistently use
  // "Condensed Consolidated Statements of Operations" (or Income), etc.
  {
    tag: 'income_statement',
    patterns: [
      /\b(?:Condensed )?Consolidated Statements? of (?:Operations|Income|Comprehensive Income|Earnings)\b/gi,
      /\bConsolidated Statements? of Operations and Comprehensive (?:Income|Loss)\b/gi,
      /\bUNAUDITED CONDENSED CONSOLIDATED STATEMENTS? OF OPERATIONS\b/g,
    ],
    priority: 10,
  },
  {
    tag: 'balance_sheet',
    patterns: [
      /\b(?:Condensed )?Consolidated Balance Sheets?\b/gi,
      /\bUNAUDITED CONDENSED CONSOLIDATED BALANCE SHEETS?\b/g,
    ],
    priority: 10,
  },
  {
    tag: 'cash_flow',
    patterns: [
      /\b(?:Condensed )?Consolidated Statements? of Cash Flows?\b/gi,
      /\bUNAUDITED CONDENSED CONSOLIDATED STATEMENTS? OF CASH FLOWS?\b/g,
    ],
    priority: 10,
  },
  {
    tag: 'equity_statement',
    patterns: [
      /\b(?:Condensed )?Consolidated Statements? of (?:Stockholders'?|Shareholders'?) Equity\b/gi,
      /\b(?:Condensed )?Consolidated Statements? of Changes in (?:Stockholders'?|Shareholders'?) Equity\b/gi,
    ],
    priority: 10,
  },
  {
    tag: 'notes',
    patterns: [
      /\bNotes to (?:the )?(?:Condensed )?Consolidated Financial Statements\b/gi,
      /\bNotes to (?:Unaudited )?Financial Statements\b/gi,
    ],
    priority: 8,
  },
  // --- 10-Q / 10-K major Items ---
  {
    tag: 'mdna',
    patterns: [
      /\bITEM\s+2\.?\s+MANAGEMENT['’]?S DISCUSSION AND ANALYSIS/gi,
      /\bITEM\s+7\.?\s+MANAGEMENT['’]?S DISCUSSION AND ANALYSIS/gi,
      /\bManagement['’]?s Discussion and Analysis of Financial Condition\b/gi,
    ],
    priority: 9,
  },
  {
    tag: 'market_risk',
    patterns: [
      /\bITEM\s+3\.?\s+QUANTITATIVE AND QUALITATIVE DISCLOSURES ABOUT MARKET RISK\b/gi,
      /\bITEM\s+7A\.?\s+QUANTITATIVE AND QUALITATIVE DISCLOSURES ABOUT MARKET RISK\b/gi,
    ],
    priority: 9,
  },
  {
    tag: 'controls_procedures',
    patterns: [
      /\bITEM\s+4\.?\s+CONTROLS AND PROCEDURES\b/gi,
      /\bITEM\s+9A\.?\s+CONTROLS AND PROCEDURES\b/gi,
    ],
    priority: 9,
  },
  {
    tag: 'risk_factors',
    patterns: [
      /\bITEM\s+1A\.?\s+RISK FACTORS\b/gi,
    ],
    priority: 9,
  },
  {
    tag: 'legal_proceedings',
    patterns: [
      /\bITEM\s+(?:1|3)\.?\s+LEGAL PROCEEDINGS\b/gi,
    ],
    priority: 9,
  },
  {
    tag: 'other_information',
    patterns: [
      /\bITEM\s+5\.?\s+OTHER INFORMATION\b/gi,
      /\bPART II\s*[—\-]\s*OTHER INFORMATION\b/gi,
    ],
    priority: 7,
  },
  {
    tag: 'signatures',
    patterns: [/\bSIGNATURES?\s*$/gm, /\bPursuant to the requirements of the Securities Exchange Act\b/g],
    priority: 7,
  },
  {
    tag: 'exhibits',
    patterns: [
      /\bITEM\s+6\.?\s+EXHIBITS?\b/gi,
      /\bITEM\s+15\.?\s+EXHIBITS?\b/gi,
      /\bEXHIBIT INDEX\b/gi,
    ],
    priority: 7,
  },
  // --- 8-K Items (each is its own event) ---
  {
    tag: 'eight_k_item',
    patterns: [
      /\bITEM\s+\d+\.\d+\.?\s+[A-Z]/g,
    ],
    priority: 6,
  },
];

interface SectionMarker {
  start: number;
  tag: SectionTag;
  priority: number;
}

/** Scan the text and return ordered (start, tag) markers. */
function detectMarkers(text: string): SectionMarker[] {
  const markers: SectionMarker[] = [];
  for (const { tag, patterns, priority } of SECTION_PATTERNS) {
    for (const p of patterns) {
      p.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = p.exec(text)) !== null) {
        markers.push({ start: m.index, tag, priority });
        if (!p.global) break;
      }
    }
  }
  markers.sort((a, b) => a.start - b.start || b.priority - a.priority);
  return markers;
}

/**
 * Tag every chunk with its section. Cover page is assigned positionally
 * (first ~1500 chars) since SEC filings don't put a "COVER PAGE" header.
 * Chunks before any detected marker are 'cover_page'; chunks beyond it
 * inherit the latest preceding marker's tag.
 */
export function tagChunksBySection(
  text: string,
  chunks: Array<{ charStart: number }>,
  docType: string,
): SectionTag[] {
  // For 8-K, every chunk is essentially the body of an event — tag uniformly.
  if (/^8[- ]?k$/i.test(docType.trim())) {
    return chunks.map(() => 'eight_k_item');
  }
  // For news / non-filing types, tag as news body. The section weights for
  // 'news_body' are mild boosts across all intents.
  if (!/10[- ]?[qk]$|10[- ]?k\/a$|^10[- ]?q\/a$/i.test(docType.trim())) {
    return chunks.map(() => 'news_body');
  }

  // 10-Q / 10-K filings: positional cover page, then marker-based lookup.
  const markers = detectMarkers(text);
  const COVER_PAGE_END = 1500;
  return chunks.map(c => {
    if (c.charStart < COVER_PAGE_END && (markers.length === 0 || markers[0].start > COVER_PAGE_END)) {
      return 'cover_page';
    }
    let current: SectionTag = c.charStart < COVER_PAGE_END ? 'cover_page' : 'unknown';
    for (const m of markers) {
      if (m.start > c.charStart) break;
      current = m.tag;
    }
    return current;
  });
}

/**
 * Fallback: detect a chunk's section from its own content, used at retrieval
 * time for legacy chunks that were ingested before section tagging. Less
 * precise than position-based detection since the relevant heading may live
 * just before the chunk's window rather than inside it.
 */
export function detectSectionFromChunkContent(content: string): SectionTag {
  // Scan only the first ~400 chars — section headers typically sit near
  // the start when they're present in a chunk.
  const head = content.slice(0, 600);
  for (const { tag, patterns } of SECTION_PATTERNS) {
    for (const p of patterns) {
      p.lastIndex = 0;
      if (p.test(head)) return tag;
    }
  }
  // Heuristic body-based hints for legacy chunks with no heading:
  //   - Tabular numbers across multiple rows → likely a financial statement
  //   - "We", "Our", "The Company" prose → MD&A or Risk Factors
  //   - "may", "could", "anticipates", "believes" verbs in past tense → MDA / FLS
  if (/\b(forward[- ]looking|undue reliance|safe harbor|do not place undue)\b/i.test(head)) {
    return 'forward_looking';
  }
  // Multiple $ amounts in close succession + short labels → statement table.
  const dollarSigns = (head.match(/\$\s*\d/g) ?? []).length;
  if (dollarSigns >= 4) {
    if (/cash flow|operating activit|investing activit|financing activit/i.test(head)) return 'cash_flow';
    if (/total assets|total liabilities|stockholders'? equity/i.test(head)) return 'balance_sheet';
    return 'income_statement';
  }
  if (/\b(risk factors?|adverse|materially affect|could harm)\b/i.test(head)) return 'risk_factors';
  if (/\b(we|our|the company|management)\b/i.test(head) && /\b(quarter|year|increase|decrease|grew|declined)\b/i.test(head)) {
    return 'mdna';
  }
  return 'unknown';
}
