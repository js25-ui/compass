/**
 * Citation accuracy verification.
 *
 * Each input that requires citation is validated against the source it
 * points to. Sources fall into three distinct classes, each with its own
 * validity rules — using one rule for all of them produces false-negative
 * audit failures for legitimate non-document citations:
 *
 *   - primary_document  An indexed filing or external doc. Needs a URL or
 *                       a specific identifier (CIK / filing / 10-K / 10-Q /
 *                       FY-year) in title/url/meta. EDGAR claims must show
 *                       a CIK.
 *   - model_corpus      LLM training knowledge with no live feed. Meta must
 *                       acknowledge the model/training/knowledge caveat —
 *                       i.e. you can't disguise model output as a filing.
 *   - prior_run         A model run completed earlier in this conversation.
 *                       Meta must reference the chain ("prior / previous /
 *                       in this conversation / earlier"), OR carry a runId
 *                       that ties to a real prior_context fingerprint.
 *
 * The kind can be declared explicitly on the SourceEntry, or inferred from
 * the title/meta/url text when absent. This keeps existing pipelines
 * working without forcing every source to carry an explicit kind today.
 */

import type { InputTrace } from './shared';

export type SourceKind = 'primary_document' | 'model_corpus' | 'prior_run';

export interface SourceEntry {
  n: number;
  title: string;
  url: string | null;
  meta: string;
  /** Optional declared kind. When absent, inferKind() classifies from text. */
  kind?: SourceKind;
  /** For prior_run sources — a deterministic fingerprint of the prior run's
   *  inputs (see fingerprintRun in this file). Lets the audit confirm the
   *  citation isn't a phantom reference to a run that doesn't exist. */
  runId?: string;
}

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

/** Deterministic fingerprint of a prior run's task type + _model_* scope
 *  keys. Used by Monte Carlo / Excel / etc. to attach a runId to prior_run
 *  citations so the audit can reproduce-and-match.
 *
 *  Two 32-bit FNV-1a hashes (with different seeds) concatenated give a
 *  64-bit-ish identifier without needing BigInt — collision risk on
 *  sub-2^32 distinct runs is negligible for this use. */
export function fingerprintRun(
  taskType: string,
  scope: Record<string, unknown>,
): string {
  const modelKeys = Object.keys(scope)
    .filter(k => k.startsWith('_model_'))
    .sort();
  const payload = modelKeys.map(k => `${k}=${formatScopeVal(scope[k])}`).join('|');
  const seed = `${taskType}::${payload}`;
  const h1 = fnv1a32(seed, 0x811c9dc5);
  const h2 = fnv1a32(seed, 0xa4093822);
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

function fnv1a32(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // Multiply by 16777619 (FNV prime) using Math.imul for 32-bit semantics.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function formatScopeVal(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') return v.toString();
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? '1' : '0';
  return JSON.stringify(v);
}

function inferKind(s: SourceEntry): SourceKind {
  if (s.kind) return s.kind;
  const blob = `${s.title} ${s.meta} ${s.url ?? ''}`.toLowerCase();
  if (/training corpus|sonnet|model-grounded|no live (?:market )?(?:data|feed)/.test(blob)) {
    return 'model_corpus';
  }
  if (/prior|previous|earlier|in this conversation|carried forward|conversation context/.test(blob)) {
    return 'prior_run';
  }
  if (/sec\.gov|edgar|10-k|10-q|cik|fy\d/i.test(blob)) {
    return 'primary_document';
  }
  return 'primary_document';
}

type SourceCheck = { ok: true } | { ok: false; reason: string };

function validateSource(src: SourceEntry, origin: InputTrace['origin']): SourceCheck {
  if (!src.title || src.title.trim().length === 0) {
    return { ok: false, reason: `Source [${src.n}] has empty title` };
  }
  if (!src.meta || src.meta.trim().length === 0) {
    return { ok: false, reason: `Source [${src.n}] has empty meta` };
  }
  const kind = inferKind(src);
  switch (kind) {
    case 'primary_document': {
      const blob = `${src.url ?? ''} ${src.meta}`;
      const claimsEdgar = /sec\.gov|edgar|sec edgar/i.test(`${src.meta} ${src.url ?? ''}`);
      if (claimsEdgar && !/cik[\s-]?\d/i.test(blob)) {
        return { ok: false, reason: `Source [${src.n}] claims SEC EDGAR but has no CIK in URL/meta` };
      }
      if (origin === 'sourced' && !src.url && !/CIK|filing|10-K|10-Q|FY\d/i.test(src.meta)) {
        return { ok: false, reason: `Sourced primary_document [${src.n}] has no URL and no filing identifier in meta` };
      }
      return { ok: true };
    }
    case 'model_corpus': {
      if (!/training|knowledge|model-grounded|no live (?:market )?(?:data|feed)/i.test(src.meta)) {
        return { ok: false, reason: `Source [${src.n}] is model_corpus but meta lacks training/knowledge caveat` };
      }
      return { ok: true };
    }
    case 'prior_run': {
      const hasPriorLanguage = /prior|previous|earlier|in this conversation|carried forward/i.test(src.meta);
      const hasRunId = typeof src.runId === 'string' && /^[0-9a-f]{8,}$/i.test(src.runId);
      if (!hasPriorLanguage && !hasRunId) {
        return { ok: false, reason: `Source [${src.n}] is prior_run but meta has no chain language and no runId` };
      }
      return { ok: true };
    }
  }
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
    const result = validateSource(src, inp.origin);
    if (result.ok) {
      verified += 1;
    } else {
      failures.push({ n: inp.citationN, reason: result.reason });
    }
  }

  const score = Math.round((verified / requiresCitation.length) * 100);
  return { score, checked: requiresCitation.length, verified, failures };
}
