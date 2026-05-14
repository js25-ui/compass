/**
 * Pre-flight: gather all the facts a model needs before it runs. If something
 * required is missing, attempt an XBRL re-pull. If still missing after that,
 * return a structured failure so the pipeline can refuse to run rather than
 * silently substituting placeholders.
 */

import { resolveEntity, type ResolvedEntity } from '@/lib/lookup/resolve';
import {
  getFactsForTarget,
  pickAnnualHistory,
  pickLatestAnnual,
  seedFromXbrl,
  type FactMetric,
  type FinancialFact,
} from './financial_facts';
import { upsertTarget } from '@/lib/ingest/persist';
import type { ManifestEntry, ModelDataManifest } from '@/lib/models/manifests';

export interface PreflightFailure {
  ok: false;
  reason: 'unresolved' | 'no_filings' | 'partial_data';
  missingMetrics: string[];
  detail: string;
  attempted: string[];           // sources we tried
  entity?: ResolvedEntity | null;
}

export interface PreflightSuccess {
  ok: true;
  entity: ResolvedEntity;
  facts: Record<string, FinancialFact | FinancialFact[]>;  // keyed by manifest entry
  scalar: Record<string, number>;                          // simple key → latest value (for one-off period entries)
  history: Record<string, FinancialFact[]>;                // for 'annual_history_*' entries
}

export type PreflightResult = PreflightSuccess | PreflightFailure;

export async function preflight(opts: {
  query: string;
  detectedTarget?: { name: string; ticker?: string } | null;
  manifest: ModelDataManifest;
}): Promise<PreflightResult> {
  const attempted: string[] = [];

  // Step 1 — resolve the target.
  const targetQuery = opts.detectedTarget?.name ?? opts.query;
  const entity = await resolveEntity(targetQuery);
  attempted.push('entity_resolution');
  if (!entity) {
    return {
      ok: false,
      reason: 'unresolved',
      missingMetrics: opts.manifest.required.map(r => r.metric),
      detail: `Could not resolve "${targetQuery}" to a known entity. Compass needs a SEC-filing public company (or an entity whose financials you provide manually) to run this model.`,
      attempted,
      entity: null,
    };
  }

  // Step 2 — pull cached facts for the target. A transient Supabase outage
  // here used to throw past the pipeline and surface as a raw error event
  // with no `done` — the UI saw a stream cutoff. Soft-fail to an empty
  // cache so the XBRL seed path below still gets a chance, and if that
  // also fails the manifest check below produces a clean refusal banner.
  let facts: FinancialFact[];
  try {
    facts = await getFactsForTarget(entity.id);
    attempted.push('financial_facts_cache');
  } catch (err) {
    facts = [];
    attempted.push(`financial_facts_cache_failed(${err instanceof Error ? err.message : 'unknown'})`);
  }

  // Step 3 — if cache is sparse and we have a CIK, prime from XBRL.
  // financial_facts has a FK to targets(id), so the target row must exist
  // before we seed. Entities resolved purely from the SEC tickers JSON or
  // curated lists never get an ingestion pass; persist the row first so
  // the upsert doesn't violate the FK.
  if (entity.cik && needsRefresh(opts.manifest, facts)) {
    try {
      await upsertTarget(entity, 'pending');
      attempted.push('target_persisted');
    } catch (err) {
      attempted.push(`target_persist_failed(${err instanceof Error ? err.message : 'unknown'})`);
    }
    try {
      const written = await seedFromXbrl(entity.id, entity.cik);
      attempted.push(`xbrl_seed(${written}_facts)`);
      facts = await getFactsForTarget(entity.id);
    } catch (err) {
      attempted.push(`xbrl_seed_failed(${err instanceof Error ? err.message : 'unknown'})`);
    }
  }

  // Step 4 — check the manifest.
  const scalar: Record<string, number> = {};
  const history: Record<string, FinancialFact[]> = {};
  const factsBundle: Record<string, FinancialFact | FinancialFact[]> = {};
  const missing: string[] = [];

  for (const req of opts.manifest.required) {
    const found = lookupForEntry(facts, req);
    if (!found || (Array.isArray(found) ? found.length === 0 : found.value == null)) {
      missing.push(req.metric);
      continue;
    }
    factsBundle[req.metric] = found;
    if (Array.isArray(found)) {
      history[req.metric] = found;
      if (found[0]?.value != null) scalar[req.metric] = found[0].value;
    } else if (found.value != null) {
      scalar[req.metric] = found.value;
    }
  }

  // Optional fields are recorded but never blocked on.
  for (const opt of opts.manifest.optional) {
    const found = lookupForEntry(facts, opt);
    if (!found || (Array.isArray(found) ? found.length === 0 : found.value == null)) continue;
    factsBundle[opt.metric] = found;
    if (Array.isArray(found)) {
      history[opt.metric] = found;
      if (found[0]?.value != null) scalar[opt.metric] = found[0].value;
    } else if (found.value != null) {
      scalar[opt.metric] = found.value;
    }
  }

  if (missing.length > 0) {
    const noFilings = !entity.cik || facts.length === 0;
    return {
      ok: false,
      reason: noFilings ? 'no_filings' : 'partial_data',
      missingMetrics: missing,
      detail: noFilings
        ? `${entity.name} has no SEC filings indexed (private company, sovereign, or muni). Compass cannot pull required financials [${missing.join(', ')}] without a filer.`
        : `${entity.name} is filed with the SEC but the most recent 10-K does not surface required tags [${missing.join(', ')}]. This sometimes happens with non-US issuers or companies that report in a different taxonomy.`,
      attempted,
      entity,
    };
  }

  return { ok: true, entity, facts: factsBundle, scalar, history };
}

function needsRefresh(manifest: ModelDataManifest, facts: FinancialFact[]): boolean {
  if (facts.length === 0) return true;
  for (const req of manifest.required) {
    const found = lookupForEntry(facts, req);
    if (!found) return true;
    if (Array.isArray(found) && found.length === 0) return true;
    if (!Array.isArray(found) && found.value == null) return true;
  }
  return false;
}

function lookupForEntry(facts: FinancialFact[], entry: ManifestEntry): FinancialFact | FinancialFact[] | null {
  if (entry.period === 'annual_history_3') return pickAnnualHistory(facts, entry.metric, 3);
  if (entry.period === 'annual_history_5') return pickAnnualHistory(facts, entry.metric, 5);
  // 'LTM' and 'annual_latest' both fall back to latest annual; LTM tag is the
  // same row when seeded from XBRL.
  return pickLatestAnnual(facts, entry.metric);
}

/* --- Convenience accessors used by model pipelines --- */

export function scalarOrNull(result: PreflightSuccess, metric: FactMetric): number | null {
  const v = result.scalar[metric];
  return Number.isFinite(v) ? v : null;
}

/**
 * Lightweight pre-flight for LLM-driven deliverables (Trading Comps,
 * Precedents, IC Memo, Pitch Book). Doesn't require full XBRL — only
 * verifies the target resolves to a known entity. Returns `hasFilings` so
 * the pipeline can pass that signal into the Sonnet prompt and prevent
 * the model from referencing filings that don't exist for private cos.
 */
export interface LightPreflightOk {
  ok: true;
  entity: ResolvedEntity;
  hasFilings: boolean;
  hasIndexedCorpus: boolean;
}

export interface LightPreflightFail {
  ok: false;
  reason: 'unresolved';
  detail: string;
  query: string;
}

export type LightPreflightResult = LightPreflightOk | LightPreflightFail;

export async function lightPreflight(opts: {
  query: string;
  detectedTarget?: { name: string; ticker?: string } | null;
  /** When true, also checks the indexed corpus for chunks tied to the target. */
  requireIndexedCorpus?: boolean;
}): Promise<LightPreflightResult> {
  const targetQuery = opts.detectedTarget?.name ?? opts.query;
  const entity = await resolveEntity(targetQuery);
  if (!entity) {
    return {
      ok: false,
      reason: 'unresolved',
      query: targetQuery,
      detail: `Couldn't resolve "${targetQuery}" to a known entity. The deliverable would invent a target — refusing to run.`,
    };
  }
  const hasFilings = Boolean(entity.cik);

  let hasIndexedCorpus = false;
  if (opts.requireIndexedCorpus) {
    // Cheap presence check via documents table.
    try {
      const sb = (await import('@/lib/db/client')).getSupabaseService();
      const { count } = await sb
        .from('documents')
        .select('id', { count: 'exact', head: true })
        .eq('target_id', entity.id);
      hasIndexedCorpus = (count ?? 0) > 0;
    } catch {
      hasIndexedCorpus = false;
    }
  }

  return { ok: true, entity, hasFilings, hasIndexedCorpus };
}
