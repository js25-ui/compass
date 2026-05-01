import { haikuComplete } from '@/lib/llm/anthropic';
import { ORCHESTRATOR_PROMPT } from '@/lib/llm/prompts';
import { resolveEntity, type ResolvedEntity } from '@/lib/lookup/resolve';

export type Intent = 'research' | 'modeling' | 'comparison' | 'macro' | 'historical' | 'unclear';

export interface ExtractedEntity {
  name: string;
  ticker?: string;
  type: string;
}

export interface OrchestratorOutput {
  entities: ExtractedEntity[];
  intent: Intent;
  is_historical: boolean;
  needs_clarification: boolean;
  clarification_question: string | null;
}

export interface OrchestratorResult {
  intent: Intent;
  isHistorical: boolean;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  resolved: ResolvedEntity[];
  unresolved: ExtractedEntity[];
}

/**
 * Extract entities and intent from a free-form query, then deterministically
 * resolve each extracted entity. Anything we can't resolve is returned in
 * `unresolved` so the caller can decide whether to push back on the user.
 */
export async function orchestrate(query: string): Promise<OrchestratorResult> {
  let parsed: OrchestratorOutput;
  try {
    const raw = await haikuComplete({
      systemPrompt: ORCHESTRATOR_PROMPT,
      userMessage: query,
      maxTokens: 600,
    });
    parsed = parseJson(raw);
  } catch {
    // Network/JSON failure — fall through to deterministic-only resolution.
    parsed = {
      entities: [],
      intent: 'unclear',
      is_historical: false,
      needs_clarification: false,
      clarification_question: null,
    };
  }

  // Deterministic backup: if Haiku missed entities, try resolving the raw query.
  if (parsed.entities.length === 0) {
    const direct = await resolveEntity(query);
    if (direct) {
      return {
        intent: parsed.intent,
        isHistorical: parsed.is_historical,
        needsClarification: false,
        clarificationQuestion: null,
        resolved: [direct],
        unresolved: [],
      };
    }
  }

  const resolved: ResolvedEntity[] = [];
  const unresolved: ExtractedEntity[] = [];
  for (const e of parsed.entities) {
    const candidate = e.ticker ? `${e.ticker}` : e.name;
    const r = (await resolveEntity(candidate)) ?? (await resolveEntity(e.name));
    if (r) resolved.push(r);
    else unresolved.push(e);
  }

  return {
    intent: parsed.intent,
    isHistorical: parsed.is_historical,
    needsClarification: parsed.needs_clarification,
    clarificationQuestion: parsed.clarification_question,
    resolved,
    unresolved,
  };
}

function parseJson(raw: string): OrchestratorOutput {
  // Haiku occasionally wraps JSON in markdown fences despite the instruction.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const parsed = JSON.parse(cleaned) as OrchestratorOutput;
  if (!Array.isArray(parsed.entities)) parsed.entities = [];
  return parsed;
}
