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
  "task_type": "<one of: lbo | dcf | trading_comps | precedents | ipo_valuation | bond_pricing | monte_carlo | football_field | ic_memo | pitch_book | excel_model | chat_answer>",
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
- "Excel model", "spreadsheet" → excel_model
- Open-ended questions / explanations → chat_answer

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

export async function clarifyScope(
  query: string,
  history?: ClarifyHistoryTurn[],
): Promise<ClarifyOutput> {
  // 1. Classify (Haiku — fast)
  const classification = await classifyTask(query);

  // For chat_answer, no scoping needed.
  if (classification.task_type === 'chat_answer') {
    return {
      task_type: 'chat_answer',
      asset_class: classification.asset_class,
      detected_target: classification.detected_target,
      ready_to_proceed: true,
      preface: '',
      questions: [],
      acknowledged_scope: {},
      acknowledged_pills: [],
    };
  }

  // 2. Load manifest
  const manifest = manifestFor(classification.task_type);

  // 3. Extract parameters (Sonnet)
  let extraction: ExtractionResult = { extracted: [], ambiguous: [], inferredContext: {} };
  try {
    extraction = await extractParameters({ query, manifest, history });
  } catch {
    // Fall through: no extraction, ask for everything
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
    detected_target: classification.detected_target,
    ready_to_proceed: readyToProceed,
    preface,
    questions,
    acknowledged_scope: scopeFromExtraction(extraction),
    acknowledged_pills,
  };
}

async function classifyTask(query: string): Promise<ClassifyOutput> {
  const client = getAnthropic();
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 300,
    system: [{ type: 'text', text: CLASSIFY_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: query }],
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
