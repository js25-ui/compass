/**
 * SEC XBRL company-facts client.
 *
 * The /api/xbrl/companyfacts/CIK{cik}.json endpoint returns every XBRL-tagged
 * fact for an issuer across every filing they've made (1993+ for most large
 * filers). One fetch ≈ a complete numerical dataset — Revenues, Assets,
 * Liabilities, NetIncomeLoss, etc., each with {val, fy, fp, end, form}.
 *
 * For "What was Apple's revenue in 2010?" we never need to chunk a 10-K —
 * just look up us-gaap:Revenues for fy=2010 fp=FY.
 */

const SEC_USER_AGENT = process.env.SEC_USER_AGENT ?? 'Compass <noreply@example.com>';
const COMPANY_FACTS = 'https://data.sec.gov/api/xbrl/companyfacts';

export interface XbrlFact {
  val: number;
  fy: number;                 // fiscal year
  fp: string;                 // 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4'
  start?: string;             // ISO date — duration facts only (income statement, cash flow)
  end: string;                // ISO date "2010-09-25"
  filed: string;              // ISO date filing was submitted
  form: string;               // '10-K' | '10-Q' | etc.
  accn: string;               // accession number
  frame?: string;
}

interface CompanyFactsResponse {
  cik: number;
  entityName: string;
  facts: {
    [taxonomy: string]: {
      [concept: string]: {
        label: string;
        description: string;
        units: { [unit: string]: XbrlFact[] };
      };
    };
  };
}

const cache = new Map<string, CompanyFactsResponse>();

export async function fetchCompanyFacts(cik: string): Promise<CompanyFactsResponse | null> {
  const padded = cik.padStart(10, '0');
  const cached = cache.get(padded);
  if (cached) return cached;

  const res = await fetch(`${COMPANY_FACTS}/CIK${padded}.json`, {
    headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`SEC company facts fetch failed (${res.status}) for CIK ${padded}`);

  const json = (await res.json()) as CompanyFactsResponse;
  cache.set(padded, json);
  return json;
}

/** Get the time-series of facts for a specific (taxonomy, concept) pair. */
export async function getConcept(
  cik: string,
  concept: string,
  opts: { taxonomy?: string; unit?: string } = {},
): Promise<XbrlFact[]> {
  const taxonomy = opts.taxonomy ?? 'us-gaap';
  const facts = await fetchCompanyFacts(cik);
  if (!facts) return [];
  const conceptData = facts.facts[taxonomy]?.[concept];
  if (!conceptData) return [];
  const unitKey = opts.unit ?? Object.keys(conceptData.units)[0];
  if (!unitKey) return [];
  return conceptData.units[unitKey] ?? [];
}

export interface AnnualFinancials {
  fy: number;
  end: string;
  revenue: number | null;
  netIncome: number | null;
  totalAssets: number | null;
  totalLiabilities: number | null;
  cashAndEquivalents: number | null;
  longTermDebt: number | null;
  operatingIncome: number | null;
  grossProfit: number | null;
  source: { form: string; accn: string; filed: string };
}

const ANNUAL_CONCEPTS = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet'],
  netIncome: ['NetIncomeLoss'],
  totalAssets: ['Assets'],
  totalLiabilities: ['Liabilities'],
  cashAndEquivalents: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
  longTermDebt: ['LongTermDebtNoncurrent', 'LongTermDebt'],
  operatingIncome: ['OperatingIncomeLoss'],
  grossProfit: ['GrossProfit'],
} as const;

/**
 * Merge facts across candidate concepts: per fiscal year, take the value from
 * the first candidate concept that has FY data. Issuers change tags over time
 * (Apple used SalesRevenueNet then switched to RevenueFromContractWithCustomer,
 * etc.) so a single concept rarely covers a full history.
 */
async function mergeAcrossConcepts(cik: string, candidates: readonly string[]): Promise<Map<number, XbrlFact>> {
  const out = new Map<number, XbrlFact>();
  for (const c of candidates) {
    const facts = await getConcept(cik, c);
    for (const f of facts) {
      if (f.fp !== 'FY') continue;
      if (!out.has(f.fy)) out.set(f.fy, f);
    }
  }
  return out;
}

/** Build annual financials for a CIK. Picks the FY datapoint per fiscal year. */
export async function getAnnualFinancials(cik: string, year?: number): Promise<AnnualFinancials[]> {
  const buckets = new Map<number, AnnualFinancials>();

  for (const [field, candidates] of Object.entries(ANNUAL_CONCEPTS) as Array<
    [keyof typeof ANNUAL_CONCEPTS, readonly string[]]
  >) {
    const merged = await mergeAcrossConcepts(cik, candidates);
    for (const [fy, f] of merged) {
      if (year && fy !== year) continue;
      let bucket = buckets.get(fy);
      if (!bucket) {
        bucket = {
          fy,
          end: f.end,
          revenue: null,
          netIncome: null,
          totalAssets: null,
          totalLiabilities: null,
          cashAndEquivalents: null,
          longTermDebt: null,
          operatingIncome: null,
          grossProfit: null,
          source: { form: f.form, accn: f.accn, filed: f.filed },
        };
        buckets.set(fy, bucket);
      }
      bucket[field] = f.val;
    }
  }

  return [...buckets.values()].sort((a, b) => a.fy - b.fy);
}
