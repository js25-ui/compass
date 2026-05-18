/**
 * Clarification orchestrator.
 *
 * Flow:
 *   1. Haiku classifies the user query into a TaskType.
 *   2. Load the manifest for that task type from lib/manifests.
 *   3. Run the Parameter Extraction Agent (Sonnet 4.5) — picks up params
 *      already specified in the prompt or conversation history.
 *   4. Render a clarification card with:
 *        - "What I have" acknowledgement pills (extracted params, source-tagged)
 *        - Form inputs only for the still-missing required + recommended params
 *
 * If the user already specified everything required + recommended, the card is
 * skipped entirely (`ready_to_proceed = true`).
 */

import { getAnthropic, HAIKU_MODEL } from '@/lib/llm/anthropic';
import { manifestFor, type TaskManifest } from '@/lib/manifests';
import { extractParameters, buildAcknowledgement, type AcknowledgementPill, type ExtractionResult } from './parameter_extractor';
import type { ParamSpec, TaskType } from '@/lib/manifests/types';

export type Intent = TaskType;
export type AssetClass = 'equity' | 'debt' | 'muni' | 'private_equity' | 'macro' | 'unknown';

export interface ClarifyOption {
  value: string;
  label: string;
}

export interface ClarifyQuestion {
  id: string;
  prompt: string;
  kind: 'select' | 'multi_select' | 'numeric' | 'text' | 'boolean';
  default?: string | number | boolean | string[];
  options?: ClarifyOption[];
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
}

export interface ClarifyOutput {
  task_type: TaskType;
  asset_class: AssetClass;
  detected_target: { name: string; ticker?: string } | null;
  ready_to_proceed: boolean;
  preface: string;
  questions: ClarifyQuestion[];
  /** Pre-extracted scope; the UI submits these alongside any new answers. */
  acknowledged_scope: Record<string, string | number | boolean | string[]>;
  /** Pills for the acknowledgement section. */
  acknowledged_pills: AcknowledgementPill[];
}

const CLASSIFY_PROMPT = `Classify the user's request into a TaskType + target.

Output STRICT JSON:
{
  "task_type": "<one of: lbo | dcf | trading_comps | precedents | ipo_valuation | bond_pricing | monte_carlo | football_field | ic_memo | pitch_book | excel_model | sector_screen | chat_answer>",
  "asset_class": "equity | debt | muni | private_equity | macro | unknown",
  "detected_target": { "name": "<canonical>", "ticker": "<TKR if known>" } | null,
  "confidence": 0-1
}

Mapping cheat sheet:
- "LBO model", "buyout", "take-private", "sponsor returns" → lbo
- "DCF", "discounted cash flow", "intrinsic value" → dcf
- "trading comps", "comp screen", "peer multiples" → trading_comps
- "precedent transactions", "M&A history", "deal comps" → precedents
- "IPO pricing", "IPO valuation", "S-1 analysis" → ipo_valuation
- "bond pricing", "spread", "new issue", "30Y notes" → bond_pricing
- "Monte Carlo", "stochastic", "distribution" → monte_carlo
- "football field" → football_field
- "IC memo", "investment memo", "approval memo" → ic_memo
- "pitch book", "pitch deck", "deck" → pitch_book
- "Excel model", "spreadsheet", "export to excel", "download as xlsx" → excel_model
- CATEGORY / SECTOR queries with NO specific company name → sector_screen.
    Triggers: "largest X", "top X", "biggest X", "major X", "leading X",
    "list of X" where X is a SECTOR (REITs, banks, semiconductors,
    airlines, restaurants, ecommerce, oil majors, pharma, etc.). Also
    triggers when the user asks for "composition and key financials" of
    a sector, or "give me the biggest names in X".
    For sector_screen, detected_target SHOULD BE NULL (it's a category,
    not a single entity).
- Open-ended questions / explanations → chat_answer

DISAMBIGUATION:
- "DCF on Apple" → dcf with target Apple (specific entity, NOT sector_screen)
- "largest REITs" → sector_screen, target null (category, no specific name)
- "Snowflake trading comps" → trading_comps (specific anchor entity)
- "biggest SaaS companies" → sector_screen (category, no specific company)

Be specific in detected_target. For "compare Apple to Microsoft", target_name = "Apple" (primary).

Output JSON only.`;

interface ClassifyOutput {
  task_type: TaskType;
  asset_class: AssetClass;
  detected_target: { name: string; ticker?: string } | null;
  confidence: number;
}

export interface ClarifyHistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ClarifyContext {
  history?: ClarifyHistoryTurn[];
  priorContext?: {
    task_type: string;
    detected_target: { name: string; ticker?: string } | null;
    scope: Record<string, string | number | boolean | string[]>;
  } | null;
}

export async function clarifyScope(
  query: string,
  ctx: ClarifyContext = {},
): Promise<ClarifyOutput> {
  const history = ctx.history;
  const priorContext = ctx.priorContext;

  // 1. Classify (Haiku — fast). History is given as a hint so the model
  //    can resolve "it" / "the same" / "this company" to a prior target.
  const classification = await classifyTask(query, history, priorContext);

  // Entity inheritance: if classify returned no target and prior conversation
  // established one, carry it forward unless the query explicitly names a new one.
  let resolvedTarget = classification.detected_target;
  if (!resolvedTarget && priorContext?.detected_target) {
    resolvedTarget = priorContext.detected_target;
  }

  // For chat_answer, no scoping needed.
  if (classification.task_type === 'chat_answer') {
    return {
      task_type: 'chat_answer',
      asset_class: classification.asset_class,
      detected_target: resolvedTarget,
      ready_to_proceed: true,
      preface: '',
      questions: [],
      acknowledged_scope: {},
      acknowledged_pills: [],
    };
  }

  // Sector-screen is a category query — no per-entity target, no need for
  // a scope form. The pipeline matches the sector phrase against the
  // configured sector list and defaults top_n=5. Pass the raw query
  // through as scope.sector and proceed directly.
  if (classification.task_type === 'sector_screen') {
    return {
      task_type: 'sector_screen',
      asset_class: classification.asset_class,
      detected_target: null,
      ready_to_proceed: true,
      preface: '',
      questions: [],
      acknowledged_scope: { sector: query },
      acknowledged_pills: [{
        paramId: 'sector',
        label: `Sector: "${query.slice(0, 80)}"`,
        source: 'current_prompt',
      }],
    };
  }

  // 2. Load manifest
  const manifest = manifestFor(classification.task_type);

  // 3. Extract parameters (Sonnet) — history is THE thing that prevents us
  //    from re-asking what the user already said earlier in the conversation.
  let extraction: ExtractionResult = { extracted: [], ambiguous: [], inferredContext: {} };
  try {
    extraction = await extractParameters({ query, manifest, history });
  } catch {
    // Fall through: no extraction, ask for everything
  }

  // Carry forward any prior-task scope params that share an id with the new
  // task's manifest. Same-named params (hold_period, leverage_multiple, etc.)
  // ARE the user's standing preferences — don't make them re-state.
  if (priorContext?.scope) {
    const manifestParamIds = new Set([
      ...manifest.required.map(p => p.id),
      ...manifest.recommended.map(p => p.id),
      ...manifest.optional.map(p => p.id),
    ]);
    const alreadyExtractedIds = new Set(extraction.extracted.map(e => e.paramId));
    for (const [paramId, value] of Object.entries(priorContext.scope)) {
      if (!manifestParamIds.has(paramId)) continue;
      if (alreadyExtractedIds.has(paramId)) continue;          // current prompt wins
      // Only carry forward simple value types
      if (value === null || value === undefined) continue;
      extraction.extracted.push({
        paramId,
        value: value as string | number | boolean | string[],
        source: 'conversation_history',
        confidence: 0.85,
        originalText: '(carried from prior turn)',
      });
    }
  }

  // 4. Determine which manifest params still need to be asked.
  const extractedIds = new Set(extraction.extracted.map(e => e.paramId));
  const ambiguousIds = new Set(extraction.ambiguous.map(a => a.paramId));
  const missingRequired = manifest.required.filter(p => !extractedIds.has(p.id));
  const missingRecommended = manifest.recommended.filter(p => !extractedIds.has(p.id));

  const questions: ClarifyQuestion[] = [...missingRequired, ...missingRecommended].map(p => specToQuestion(p, ambiguousIds.has(p.id), extraction));

  const readyToProceed = missingRequired.length === 0 && missingRecommended.length === 0;

  // Build the preface
  const acknowledged_pills = buildAcknowledgement(extraction, manifest);
  const preface = buildPreface({
    manifest,
    target: classification.detected_target,
    pills: acknowledged_pills,
    questionsCount: questions.length,
    readyToProceed,
  });

  return {
    task_type: classification.task_type,
    asset_class: classification.asset_class,
    detected_target: resolvedTarget,
    ready_to_proceed: readyToProceed,
    preface,
    questions,
    acknowledged_scope: scopeFromExtraction(extraction),
    acknowledged_pills,
  };
}

async function classifyTask(
  query: string,
  history?: ClarifyHistoryTurn[],
  priorContext?: ClarifyContext['priorContext'],
): Promise<ClassifyOutput> {
  const client = getAnthropic();

  // Build a single user message that surfaces history + prior target so the
  // classifier can resolve pronoun-style references ("it", "this", "same one").
  const parts: string[] = [];
  if (priorContext?.detected_target?.name) {
    parts.push(
      `Prior conversation context: most recent target = ${priorContext.detected_target.name}${priorContext.detected_target.ticker ? ` (${priorContext.detected_target.ticker})` : ''}, prior task = ${priorContext.task_type}.`,
    );
  }
  if (history && history.length > 0) {
    const compact = history
      .slice(-6)
      .map(t => `[${t.role}] ${t.text.slice(0, 400)}`)
      .join('\n');
    parts.push(`Recent conversation:\n${compact}`);
  }
  parts.push(`Current user message: ${query}`);
  parts.push('Classify the CURRENT message in light of the prior context. If the user uses "it" / "this" / "the same one" / "that target", inherit the prior target verbatim. If they explicitly name a different entity, switch.');

  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 300,
    system: [{ type: 'text', text: CLASSIFY_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  });
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('');
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) {
    return { task_type: 'chat_answer', asset_class: 'unknown', detected_target: null, confidence: 0 };
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as ClassifyOutput;
  } catch {
    return { task_type: 'chat_answer', asset_class: 'unknown', detected_target: null, confidence: 0 };
  }
}

function specToQuestion(spec: ParamSpec, isAmbiguous: boolean, extraction: ExtractionResult): ClarifyQuestion {
  // If the param was mentioned ambiguously, surface the original phrase as a hint.
  let hint = spec.hint;
  if (isAmbiguous) {
    const a = extraction.ambiguous.find(x => x.paramId === spec.id);
    if (a) hint = `You mentioned "${a.originalText}" — please pin a value. ${spec.hint ?? ''}`;
  }
  return {
    id: spec.id,
    prompt: spec.prompt,
    kind: spec.kind,
    default: spec.default,
    options: spec.options,
    unit: spec.unit,
    min: spec.min,
    max: spec.max,
    step: spec.step,
    hint,
  };
}

function scopeFromExtraction(extraction: ExtractionResult): Record<string, string | number | boolean | string[]> {
  const scope: Record<string, string | number | boolean | string[]> = {};
  for (const e of extraction.extracted) scope[e.paramId] = e.value;
  return scope;
}

interface PrefaceArgs {
  manifest: TaskManifest;
  target: { name: string; ticker?: string } | null;
  pills: AcknowledgementPill[];
  questionsCount: number;
  readyToProceed: boolean;
}

function buildPreface(args: PrefaceArgs): string {
  const targetLabel = args.target?.name ? args.target.name + (args.target.ticker ? ` (${args.target.ticker})` : '') : args.manifest.label;
  if (args.readyToProceed) {
    return `Got it — ${targetLabel} ${args.manifest.label}${args.pills.length > 0 ? ' with ' + args.pills.map(p => p.label).join(', ') : ''}. Running.`;
  }
  if (args.pills.length === 0) {
    return `Got it — ${targetLabel} ${args.manifest.label}. ${args.questionsCount} parameter${args.questionsCount === 1 ? '' : 's'} before I build.`;
  }
  const ackList = args.pills.map(p => p.label).join(', ');
  return `Got it — ${targetLabel} ${args.manifest.label} with ${ackList}. ${args.questionsCount} more parameter${args.questionsCount === 1 ? '' : 's'} before I build.`;
}
