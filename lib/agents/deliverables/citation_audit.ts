/**
 * Citation accuracy verification.
 *
 * For each sourced input, verify that:
 *  (a) it carries a citationN pointer
 *  (b) the citationN points to a real entry in the sources array
 *  (c) the source has a non-empty title and meta
 *  (d) when the source claims SEC EDGAR, the URL or meta contains a CIK
 *
 * Inputs tagged model_knowledge are held to a softer bar — they must cite
 * an entry in sources, but the source's url can be null since model
 * knowledge has no public URL.
 *
 * This is intentionally not a "does the cited document actually contain
 * the cited fact" verification — that would require a re-retrieval pass
 * against the corpus on every run. What we can verify cheaply is that the
 * citation chain is internally consistent and not a phantom pointer.
 */

import type { InputTrace } from './shared';

export interface CitationFailure {
  n: number;            // citation index that failed (or 0 if input never carried one)
  reason: string;
}

export interface CitationAudit {
  score: number;        // 0-100
  checked: number;      // number of inputs that needed verification
  verified: number;     // number that passed
  failures: CitationFailure[];
}

interface SourceEntry {
  n: number;
  title: string;
  url: string | null;
  meta: string;
}

export function auditCitations(inputs: InputTrace[], sources: SourceEntry[]): CitationAudit {
  // Only sourced + model_knowledge inputs need a citation. user_assumption
  // and default are explicitly non-cited by design.
  const requiresCitation = inputs.filter(i => i.origin === 'sourced' || i.origin === 'model_knowledge');
  if (requiresCitation.length === 0) {
    return { score: 0, checked: 0, verified: 0, failures: [] };
  }

  const sourcesByN = new Map(sources.map(s => [s.n, s]));
  const failures: CitationFailure[] = [];
  let verified = 0;

  for (const inp of requiresCitation) {
    if (inp.citationN == null) {
      failures.push({ n: 0, reason: `${inp.label ?? inp.field} (${inp.origin}) carries no citation pointer` });
      continue;
    }
    const src = sourcesByN.get(inp.citationN);
    if (!src) {
      failures.push({ n: inp.citationN, reason: `${inp.label ?? inp.field} cites [${inp.citationN}] but no such source in the sources array` });
      continue;
    }
    if (!src.title || src.title.trim().length === 0) {
      failures.push({ n: inp.citationN, reason: `Source [${inp.citationN}] has empty title` });
      continue;
    }
    if (!src.meta || src.meta.trim().length === 0) {
      failures.push({ n: inp.citationN, reason: `Source [${inp.citationN}] has empty meta` });
      continue;
    }
    // SEC EDGAR claim → require CIK in url or meta
    const claimsEdgar = /sec\.gov|edgar|sec edgar/i.test(`${src.meta} ${src.url ?? ''}`);
    if (claimsEdgar && !/cik[\s-]?\d/i.test(`${src.url ?? ''} ${src.meta}`)) {
      failures.push({ n: inp.citationN, reason: `Source [${inp.citationN}] claims SEC EDGAR but has no CIK in URL/meta` });
      continue;
    }
    // sourced claim with no URL and no specific identifier in meta → suspect
    if (inp.origin === 'sourced' && !src.url && !/CIK|filing|10-K|10-Q|FY\d/i.test(src.meta)) {
      failures.push({ n: inp.citationN, reason: `Sourced input [${inp.citationN}] points to a source with no URL and no specific identifier` });
      continue;
    }
    verified += 1;
  }

  const score = Math.round((verified / requiresCitation.length) * 100);
  return { score, checked: requiresCitation.length, verified, failures };
}
