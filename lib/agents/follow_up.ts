/**
 * Follow-up detection.
 *
 * When the user types a short message after a successful deliverable —
 * "re-run with $11B", "what if leverage is 7x", "same analysis but Apple" —
 * the orchestrator should NOT treat it as a fresh task. It should reuse the
 * prior task's target + scope, apply the new message as overrides, and skip
 * the clarification card.
 */

import { resolveEntity, type ResolvedEntity } from '@/lib/lookup/resolve';

const FOLLOW_UP_PATTERNS: RegExp[] = [
  /\bre[- ]?run\b/i,
  /\brun\s+(?:it\s+)?again\b/i,
  /\binstead\b/i,
  /\bactually\b/i,
  /\bbut\s+(?:with|on|for)\b/i,
  /\bwhat\s+if\b/i,
  /\bwhat\s+about\b/i,
  /\bhow\s+about\b/i,
  /\bthe\s+same\b/i,
  /\bsame\s+(?:analysis|model|deliverable)\b/i,
  /\b(?:change|update|modify|bump)\s+\w+\s+to\b/i,
  /^\s*(?:at|with)\s+\$?[\d.]/i,           // "at $11B", "with 7x"
  /^\s*(?:try|model)\s+(?:it\s+)?(?:at|with)\b/i,
];

export interface FollowUpDetection {
  isFollowUp: boolean;
  matchedPattern?: string;
  /** New entity the user explicitly names in the follow-up, if any (e.g. "but Apple"). */
  newTarget: ResolvedEntity | null;
}

export function detectFollowUpSignal(query: string): { isFollowUp: boolean; matchedPattern?: string } {
  for (const p of FOLLOW_UP_PATTERNS) {
    const m = query.match(p);
    if (m) return { isFollowUp: true, matchedPattern: m[0] };
  }
  // Heuristic: very short messages (< 8 words) that contain a $ amount or
  // an "Nx" multiple are almost always parameter tweaks.
  const wordCount = query.trim().split(/\s+/).length;
  if (wordCount <= 6 && (/\$\s*[\d.]/.test(query) || /\b\d+(?:\.\d+)?x\b/i.test(query))) {
    return { isFollowUp: true, matchedPattern: '<short numeric tweak>' };
  }
  return { isFollowUp: false };
}

/**
 * Try to detect a NEW target the user is naming in a follow-up. Returns
 * a resolved entity if and only if (a) we found a candidate phrase, (b)
 * it resolves, and (c) it's different from the prior target.
 */
export async function detectTargetSwitch(
  query: string,
  priorTargetName: string | null,
): Promise<ResolvedEntity | null> {
  const candidates: string[] = [];

  // "on X", "for X", "but X" patterns — common follow-up framings.
  const patterns = [
    /(?:^|\s)(?:on|for|with)\s+([A-Z][\w&.\-]+(?:\s+[A-Z][\w&.\-]+){0,2})/g,
    /(?:^|\s)(?:but|instead|switch\s+to)\s+([A-Z][\w&.\-]+(?:\s+[A-Z][\w&.\-]+){0,2})/g,
  ];
  for (const p of patterns) {
    let m: RegExpExecArray | null;
    while ((m = p.exec(query)) !== null) {
      const name = m[1].trim();
      // Skip "the same", "this", etc. — won't resolve anyway.
      if (name.length < 2) continue;
      candidates.push(name);
    }
  }

  // Also consider standalone tickers ($AAPL, AAPL).
  const tickerMatches = query.match(/\$?[A-Z]{2,5}\b/g) ?? [];
  for (const t of tickerMatches) candidates.push(t);

  for (const c of candidates) {
    const resolved = await resolveEntity(c);
    if (!resolved) continue;
    // Skip if resolves back to the same entity we already had context on.
    if (priorTargetName && normalizeName(resolved.name) === normalizeName(priorTargetName)) continue;
    return resolved;
  }
  return null;
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

export async function detectFollowUp(
  query: string,
  priorTargetName: string | null,
): Promise<FollowUpDetection> {
  const signal = detectFollowUpSignal(query);
  if (!signal.isFollowUp) return { isFollowUp: false, newTarget: null };
  const newTarget = await detectTargetSwitch(query, priorTargetName);
  return { isFollowUp: true, matchedPattern: signal.matchedPattern, newTarget };
}
