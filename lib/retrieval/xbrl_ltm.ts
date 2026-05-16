/**
 * LTM (last-twelve-months) financials from XBRL company facts.
 *
 * Trading Comps needs current LTM revenue / operating income / gross profit
 * for every peer. The existing `getAnnualFinancials` only returns FY
 * datapoints (fp=FY) which can be 6-12 months stale by mid-fiscal-year.
 *
 * Strategy: prefer the most recent fp=FY (10-K just filed); if the latest
 * 10-Q is more recent, roll the period forward using
 *   LTM = previous_FY + YTD_current − YTD_prior_year_same_period
 *
 * This matches how analysts compute LTM by hand. Falls back to the most
 * recent fp=FY if the YTD calculation isn't available.
 */
import { fetchCompanyFacts, getConcept, type XbrlFact } from './xbrl';

export interface LtmFinancials {
  /** $M (millions) — null if not derivable from XBRL. */
  ltmRevenue: number | null;
  ltmOperatingIncome: number | null;
  ltmGrossProfit: number | null;
  /** YoY growth on LTM revenue vs the equivalent period one year prior. */
  ltmRevenueGrowthPct: number | null;
  /** Most recent filing date in ANY fact for this issuer (max filed). */
  latestFilingDate: string | null;
  /** End date of the LTM period (the `end` of the latest-period contribution). */
  periodEnd: string | null;
  /** Form whose facts produced the latest period (10-K or 10-Q). */
  latestForm: string | null;
}

const REVENUE_CONCEPTS = [
  'Revenues',
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'SalesRevenueNet',
] as const;
const OPERATING_INCOME_CONCEPTS = ['OperatingIncomeLoss'] as const;
const GROSS_PROFIT_CONCEPTS = ['GrossProfit'] as const;

/**
 * Public entry point — call once per peer. Hits the cached
 * `fetchCompanyFacts` so repeated calls are cheap.
 */
export async function getLtmFinancials(cik: string): Promise<LtmFinancials | null> {
  const facts = await fetchCompanyFacts(cik);
  if (!facts) return null;

  const rev = await mergeConcepts(cik, REVENUE_CONCEPTS);
  const oi = await mergeConcepts(cik, OPERATING_INCOME_CONCEPTS);
  const gp = await mergeConcepts(cik, GROSS_PROFIT_CONCEPTS);

  const ltmRev = computeLtm(rev);
  const ltmOI = computeLtm(oi);
  const ltmGP = computeLtm(gp);

  // YoY growth: compute LTM at the equivalent period one year ago and
  // compare. We need the LTM ending ~365 days before `ltmRev.periodEnd`.
  let growth: number | null = null;
  if (ltmRev?.value != null && ltmRev.periodEnd) {
    const priorEndIso = shiftDateIsoByDays(ltmRev.periodEnd, -365);
    if (priorEndIso) {
      const prior = computeLtm(rev, priorEndIso);
      if (prior?.value != null && prior.value > 0) {
        growth = ((ltmRev.value - prior.value) / prior.value) * 100;
      }
    }
  }

  // Find max filed date across the merged concepts (used by the staleness
  // filter — companies acquired / taken private stop filing).
  const latestFiled = pickLatestFiled([...rev, ...oi, ...gp]);

  return {
    ltmRevenue: ltmRev?.value ?? null,
    ltmOperatingIncome: ltmOI?.value ?? null,
    ltmGrossProfit: ltmGP?.value ?? null,
    ltmRevenueGrowthPct: growth,
    latestFilingDate: latestFiled,
    periodEnd: ltmRev?.periodEnd ?? ltmOI?.periodEnd ?? ltmGP?.periodEnd ?? null,
    latestForm: ltmRev?.form ?? ltmOI?.form ?? gp?.[0]?.form ?? null,
  };
}

/**
 * Merge facts across candidate concepts. Some issuers tag revenue as
 * `Revenues`, others as `RevenueFromContractWithCustomerExcludingAssessedTax`,
 * etc. We pull all candidates and dedupe by (fy, fp, start, end) keeping the
 * first non-null value.
 */
async function mergeConcepts(cik: string, candidates: readonly string[]): Promise<XbrlFact[]> {
  const seen = new Map<string, XbrlFact>();
  for (const c of candidates) {
    const facts = await getConcept(cik, c);
    for (const f of facts) {
      // Include start in the key so YTD (e.g. start=2025-02-01, end=2025-10-31)
      // and QTD (start=2025-08-01, end=2025-10-31) variants of the same fp
      // don't collide.
      const key = `${f.fy}|${f.fp}|${f.start ?? ''}|${f.end}|${f.form}`;
      if (!seen.has(key)) seen.set(key, f);
    }
  }
  return [...seen.values()];
}

interface LtmResult {
  /** Sum in $M (millions). */
  value: number;
  periodEnd: string;
  form: string;
}

/**
 * Compute LTM for a single concept's fact stream.
 *
 * If `asOfEnd` is set, use the period ending on/before that date instead of
 * the absolute most recent — needed for the "LTM one year ago" YoY base.
 */
function computeLtm(allFacts: XbrlFact[], asOfEnd?: string): LtmResult | null {
  if (allFacts.length === 0) return null;

  const facts = asOfEnd
    ? allFacts.filter(f => f.end <= asOfEnd)
    : allFacts;
  if (facts.length === 0) return null;

  // Find the latest 10-K (fp=FY) and the latest 10-Q.
  const fyFacts = facts.filter(f => f.fp === 'FY' && isAnnualDuration(f));
  const qFacts = facts.filter(f => f.fp !== 'FY' && f.form === '10-Q');

  fyFacts.sort((a, b) => b.end.localeCompare(a.end));
  qFacts.sort((a, b) => b.end.localeCompare(a.end));

  const latestFy = fyFacts[0];
  const latestQ = qFacts[0];

  // Case 1: latest 10-K is the freshest report. LTM = FY revenue.
  if (latestFy && (!latestQ || latestFy.end >= latestQ.end)) {
    const valueM = latestFy.val / 1_000_000;
    return { value: valueM, periodEnd: latestFy.end, form: '10-K' };
  }

  // Case 2: latest 10-Q is fresher than the most recent 10-K. Roll forward:
  //   LTM = previous_FY + YTD_current - YTD_prior_year_same_period
  //
  // To do this we need (a) a YTD-duration fact for the current period and
  // (b) a YTD-duration fact for the prior year covering the same number of
  // months. SEC tags both — e.g. Q3 10-Q includes a 9-month YTD fact AND a
  // 3-month QTD fact. We want the YTD ones.
  if (latestQ && latestFy) {
    const currentYtd = pickYtdFact(qFacts, latestQ.end);
    if (currentYtd) {
      const ytdDays = daysBetween(currentYtd.start, currentYtd.end);
      const priorYtd = findPriorYearYtd(qFacts, currentYtd.end, ytdDays);
      if (priorYtd) {
        const ltmRaw = latestFy.val + currentYtd.val - priorYtd.val;
        const ltmM = ltmRaw / 1_000_000;
        return { value: ltmM, periodEnd: currentYtd.end, form: '10-Q' };
      }
      // Fallback: no prior-year YTD to subtract — return FY as best-effort.
      return {
        value: latestFy.val / 1_000_000,
        periodEnd: latestFy.end,
        form: '10-K',
      };
    }
  }

  // Case 3: no FY fact at all but we have a 10-Q YTD. Use the YTD value as
  // an LTM proxy with a caveat by form='10-Q'.
  if (latestQ) {
    const ytd = pickYtdFact(qFacts, latestQ.end);
    if (ytd && daysBetween(ytd.start, ytd.end) >= 270) {
      return { value: ytd.val / 1_000_000, periodEnd: ytd.end, form: '10-Q' };
    }
  }
  return null;
}

function isAnnualDuration(f: XbrlFact): boolean {
  if (!f.start) return f.fp === 'FY';
  const days = daysBetween(f.start, f.end);
  return days >= 340 && days <= 380;
}

function daysBetween(start: string, end: string): number {
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return 0;
  return Math.round((e - s) / (1000 * 60 * 60 * 24));
}

/**
 * Among 10-Q facts ending on `endDate`, pick the one whose duration suggests
 * year-to-date (the longest duration that ends on this date). For Q1 the YTD
 * is just the 88-91-day quarter; for Q3 it's a 273-day 9-month period.
 */
function pickYtdFact(qFacts: XbrlFact[], endDate: string): (XbrlFact & { start: string }) | null {
  const candidates = qFacts.filter((f): f is XbrlFact & { start: string } => f.end === endDate && typeof f.start === 'string');
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => daysBetween(b.start, b.end) - daysBetween(a.start, a.end));
  return candidates[0];
}

/**
 * Find the YTD fact one year prior to `endDate` with approximately the same
 * duration in days. We accept ±10 days slack for leap years / 4-4-5 weeks.
 */
function findPriorYearYtd(qFacts: XbrlFact[], endDate: string, ytdDays: number): XbrlFact | null {
  const targetEndMs = Date.parse(endDate);
  if (Number.isNaN(targetEndMs)) return null;
  const targetPriorEndMs = targetEndMs - 365 * 24 * 60 * 60 * 1000;
  let best: XbrlFact | null = null;
  let bestDelta = Infinity;
  for (const f of qFacts) {
    if (typeof f.start !== 'string') continue;
    const dur = daysBetween(f.start, f.end);
    if (Math.abs(dur - ytdDays) > 10) continue;
    const endMs = Date.parse(f.end);
    if (Number.isNaN(endMs)) continue;
    const delta = Math.abs(endMs - targetPriorEndMs);
    if (delta < bestDelta && delta < 30 * 24 * 60 * 60 * 1000) {
      bestDelta = delta;
      best = f;
    }
  }
  return best;
}

function shiftDateIsoByDays(iso: string, deltaDays: number): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const shifted = new Date(t + deltaDays * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function pickLatestFiled(facts: XbrlFact[]): string | null {
  let latest: string | null = null;
  for (const f of facts) {
    if (!f.filed) continue;
    if (!latest || f.filed > latest) latest = f.filed;
  }
  return latest;
}
