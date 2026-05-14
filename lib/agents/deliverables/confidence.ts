/**
 * Confidence score for a deliverable, derived from its input trace.
 *
 * A model that runs on sourced filings, with the user filling in only
 * assumption-level parameters, gets a higher score than one that runs
 * primarily on manifest defaults or on model-only knowledge with no live feed.
 *
 * Five weighted factors:
 *   - input_grounding    (40%) — share of inputs that are 'sourced'
 *   - assumption_share   (20%) — penalize when most inputs are user assumptions
 *                                (a model entirely driven by user inputs may
 *                                 be internally consistent but isn't anchored)
 *   - default_penalty    (15%) — defaults shouldn't dominate; each default
 *                                cuts the factor
 *   - source_freshness   (15%) — if any sourced input cites a period > 18 months
 *                                old, score is reduced
 *   - citation_coverage  (10%) — fraction of sourced inputs that carry a
 *                                specific citationN pointer
 *
 * Returns a 0-100 integer and a breakdown the Work tab can render.
 */

import type { InputTrace } from './shared';

export interface ConfidenceBreakdown {
  factor: string;
  weight: number;     // 0-1
  value: number;      // 0-1
  note: string;
}

export interface ConfidenceResult {
  score: number;      // 0-100
  breakdown: ConfidenceBreakdown[];
}

export function computeConfidence(inputs: InputTrace[]): ConfidenceResult {
  if (inputs.length === 0) {
    return {
      score: 0,
      breakdown: [{ factor: 'no_inputs', weight: 1, value: 0, note: 'No input trace published — cannot score.' }],
    };
  }
  const total = inputs.length;
  const sourced = inputs.filter(i => i.origin === 'sourced').length;
  const userAssumption = inputs.filter(i => i.origin === 'user_assumption').length;
  const modelKnowledge = inputs.filter(i => i.origin === 'model_knowledge').length;
  const defaults = inputs.filter(i => i.origin === 'default').length;

  // Treat 'model_knowledge' as half-credit grounding — it's traceable to a
  // training corpus but not to a live filing.
  const grounded = sourced + 0.5 * modelKnowledge;
  const groundingValue = clamp01(grounded / total);

  // Assumption share — high user-assumption share is OK only up to ~50%.
  const assumptionRatio = userAssumption / total;
  const assumptionValue = assumptionRatio <= 0.5 ? 1 : Math.max(0, 1 - (assumptionRatio - 0.5) * 2);

  // Default penalty — each default cuts 8 points off the factor, floored at 0.
  const defaultValue = clamp01(1 - defaults * 0.08);

  // Freshness — try to detect a year from sourceRef strings like 'FY2024' or
  // '2023-12-31'. Anything ≤18 months old is full credit; older decays.
  const sourceYears = inputs
    .filter(i => i.origin === 'sourced' && i.sourceRef)
    .map(i => extractYear(i.sourceRef!))
    .filter((y): y is number => y != null);
  const now = new Date().getFullYear();
  const freshnessValue = sourceYears.length === 0
    ? 0.6
    : Math.min(...sourceYears.map(y => {
        const yearsOld = now - y;
        if (yearsOld <= 1) return 1;
        if (yearsOld <= 2) return 0.75;
        if (yearsOld <= 3) return 0.5;
        return 0.25;
      }));

  // Citation coverage — sourced inputs should carry a citationN pointer.
  const sourcedWithCitation = inputs.filter(i => i.origin === 'sourced' && i.citationN != null).length;
  const coverageValue = sourced === 0 ? 0 : sourcedWithCitation / sourced;

  const breakdown: ConfidenceBreakdown[] = [
    {
      factor: 'Input grounding',
      weight: 0.40,
      value: groundingValue,
      note: `${sourced} sourced + ${modelKnowledge} model-knowledge out of ${total} total inputs`,
    },
    {
      factor: 'Assumption share',
      weight: 0.20,
      value: assumptionValue,
      note: `${userAssumption}/${total} inputs are user assumptions${assumptionRatio > 0.5 ? ' (penalized — >50%)' : ''}`,
    },
    {
      factor: 'Default penalty',
      weight: 0.15,
      value: defaultValue,
      note: defaults === 0 ? 'No manifest defaults in play' : `${defaults} manifest defaults — each cuts 8pp`,
    },
    {
      factor: 'Source freshness',
      weight: 0.15,
      value: freshnessValue,
      note: sourceYears.length === 0
        ? 'No filing year extractable — neutral'
        : `Most recent filing year detected: ${Math.max(...sourceYears)}`,
    },
    {
      factor: 'Citation coverage',
      weight: 0.10,
      value: coverageValue,
      note: sourced === 0
        ? 'No sourced inputs to cover'
        : `${sourcedWithCitation}/${sourced} sourced inputs carry an explicit citation pointer`,
    },
  ];

  const score = Math.round(breakdown.reduce((acc, b) => acc + b.weight * b.value * 100, 0));
  return { score, breakdown };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function extractYear(s: string): number | null {
  const fy = s.match(/FY(\d{4})/);
  if (fy) return Number(fy[1]);
  const iso = s.match(/(\d{4})-\d{2}-\d{2}/);
  if (iso) return Number(iso[1]);
  const bare = s.match(/\b(20\d{2})\b/);
  if (bare) return Number(bare[1]);
  return null;
}
