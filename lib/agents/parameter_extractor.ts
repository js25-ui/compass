/**
 * Parameter Extraction Agent.
 *
 * Reads the user's natural-language query (plus optional conversation
 * history) and figures out which manifest parameters they've already
 * specified. The clarification engine uses this to AVOID asking for things
 * the user already said — including across earlier turns of a conversation
 * ("I always use 5-year holds").
 */

import { getAnthropic, SONNET_MODEL } from '@/lib/llm/anthropic';
import type { ParamSpec, TaskManifest } from '@/lib/manifests/types';

export type ExtractionSource = 'current_prompt' | 'conversation_history' | 'standing_preference' | 'inferred';

export interface ExtractedParam {
  /** Param id from the manifest (must match a real ParamSpec.id). */
  paramId: string;
  /** Resolved value, type-coerced to match ParamSpec.kind. */
  value: string | number | boolean | string[];
  /** Where it came from. */
  source: ExtractionSource;
  /** 0-1 — used to gate auto-acceptance vs ask-to-confirm. */
  confidence: number;
  /** The phrase from the user that produced this extraction. */
  originalText: string;
}

export interface AmbiguousMention {
  /** Param id that the user *probably* meant, but value is unclear. */
  paramId: string;
  originalText: string;
  reason: string;
}

export interface ExtractionResult {
  extracted: ExtractedParam[];
  ambiguous: AmbiguousMention[];
  inferredContext: {
    dealThesis?: string;
    marketView?: string;
    note?: string;
  };
}

const CONFIDENCE_HIGH = 0.8;
const CONFIDENCE_MED = 0.5;

const SYSTEM_PROMPT = `You are a parameter extraction agent for a financial-analyst workflow.

Given the user's current prompt, optional conversation history, and a manifest describing the parameters that the relevant task expects, extract any parameters the user has already specified — directly or implicitly.

Be aggressive about catching specifications:
- "$4B" or "$4 billion" → numeric in $M (4000)
- "5-year hold" → 5
- "6x leverage" or "6x" with "leverage" context → 6
- "20% CAGR" → 20
- "IPO exit" → exit_route = 'ipo'
- "Strategic sale" → exit_route = 'strategic_sale'
- "take-private" → may imply task is LBO, not a parameter on its own
- "aggressive leverage" without a number → DO NOT pick a number; mark as ambiguous
- "fast growth" without a number → ambiguous
- "Cava" → target entity (handled elsewhere; not a parameter)

Conversation history can establish:
- Standing preferences ("I always use 5-year holds")
- Prior task context ("the Cava analysis we did yesterday")

Output STRICT JSON:

{
  "extracted": [
    {
      "paramId": "<must match an id from the manifest>",
      "value": <typed correctly: number for numeric, string for select, etc.>,
      "source": "current_prompt" | "conversation_history" | "standing_preference" | "inferred",
      "confidence": 0.0-1.0,
      "originalText": "<the verbatim phrase from the user that produced this>"
    }
  ],
  "ambiguous": [
    {
      "paramId": "<best-guess id>",
      "originalText": "<the phrase>",
      "reason": "<why we can't pin a value, e.g. 'qualitative without a number'>"
    }
  ],
  "inferredContext": {
    "dealThesis": "<one sentence if relevant; else omit>",
    "marketView": "<one sentence if relevant; else omit>",
    "note": "<any other context worth carrying forward>"
  }
}

Rules:
- Output VALID JSON only — no prose, no markdown fences.
- For numeric fields: coerce to a plain number. "$4B" → 4000 (in $M). "20%" → 20. Do NOT divide percents.
- For 'select' fields: value MUST be one of the option values listed in the manifest. If the user said something close but not an exact option, lower confidence to 0.6 and use the closest match.
- For 'multi_select': value is an array of option values.
- For 'boolean': true/false (lowercase).
- Never invent an extraction. If the user didn't say it, don't list it.
- Be conservative on confidence: if there's any chance of misreading, set < 0.5 and DON'T include in extracted (move to ambiguous instead).
- Standing preferences should pull confidence to 0.85 only when the user phrased it explicitly ("I always", "use my standard", etc.).`;

interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

export async function extractParameters(opts: {
  query: string;
  manifest: TaskManifest;
  history?: ConversationTurn[];
}): Promise<ExtractionResult> {
  const client = getAnthropic();
  const manifestSummary = summarizeManifest(opts.manifest);
  const historyBlock = formatHistory(opts.history ?? []);

  const userMessage = `Current prompt: ${opts.query}

${historyBlock}

Task type: ${opts.manifest.taskType}
Manifest:
${manifestSummary}`;

  const response = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 1500,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('');

  return parseExtractionOutput(text, opts.manifest);
}

function summarizeManifest(manifest: TaskManifest): string {
  const lines: string[] = [];
  const all = [...manifest.required, ...manifest.recommended, ...manifest.optional];
  for (const p of all) {
    let line = `- ${p.id} (${p.kind}`;
    if (p.unit) line += `, ${p.unit}`;
    if (p.options) line += `, options: [${p.options.map(o => o.value).join(', ')}]`;
    line += `): ${p.label}`;
    if (p.hint) line += ` — ${p.hint}`;
    lines.push(line);
  }
  return lines.join('\n');
}

function formatHistory(history: ConversationTurn[]): string {
  if (history.length === 0) return 'Conversation history: (none)';
  const turns = history
    .slice(-10)            // cap at last 10 turns
    .map(t => `[${t.role}] ${t.text}`)
    .join('\n');
  return `Conversation history (oldest first, most recent last):\n${turns}`;
}

function parseExtractionOutput(raw: string, manifest: TaskManifest): ExtractionResult {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) {
    return { extracted: [], ambiguous: [], inferredContext: {} };
  }

  let parsed: ExtractionResult;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as ExtractionResult;
  } catch {
    return { extracted: [], ambiguous: [], inferredContext: {} };
  }

  // Normalize + validate against manifest
  const validIds = new Set([...manifest.required, ...manifest.recommended, ...manifest.optional].map(p => p.id));
  const extracted = (parsed.extracted ?? [])
    .filter(e => validIds.has(e.paramId))
    .filter(e => typeof e.confidence === 'number' && e.confidence >= CONFIDENCE_MED)
    .map(e => ({ ...e, value: coerceToParam(manifest, e.paramId, e.value) }))
    .filter((e): e is ExtractedParam => e.value !== undefined);
  const ambiguous = (parsed.ambiguous ?? []).filter(a => a.paramId && a.originalText);
  return {
    extracted,
    ambiguous,
    inferredContext: parsed.inferredContext ?? {},
  };
}

function coerceToParam(manifest: TaskManifest, paramId: string, value: unknown): ExtractedParam['value'] | undefined {
  const all = [...manifest.required, ...manifest.recommended, ...manifest.optional];
  const spec = all.find(p => p.id === paramId);
  if (!spec) return undefined;

  if (spec.kind === 'numeric') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (spec.kind === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return undefined;
  }
  if (spec.kind === 'select') {
    if (typeof value !== 'string') return undefined;
    const validValues = (spec.options ?? []).map(o => o.value);
    if (validValues.includes(value)) return value;
    return undefined;
  }
  if (spec.kind === 'multi_select') {
    if (!Array.isArray(value)) return undefined;
    const validValues = new Set((spec.options ?? []).map(o => o.value));
    const filtered = value.filter((v): v is string => typeof v === 'string' && validValues.has(v));
    return filtered.length > 0 ? filtered : undefined;
  }
  if (spec.kind === 'text') {
    return typeof value === 'string' ? value : String(value ?? '');
  }
  return undefined;
}

export function isHighConfidence(e: ExtractedParam): boolean {
  return e.confidence >= CONFIDENCE_HIGH;
}

/* --- Helpers used by the clarify orchestrator --- */

export function paramsToScope(extracted: ExtractedParam[]): Record<string, string | number | boolean | string[]> {
  const scope: Record<string, string | number | boolean | string[]> = {};
  for (const e of extracted) scope[e.paramId] = e.value;
  return scope;
}

export function extractedIds(result: ExtractionResult): Set<string> {
  return new Set(result.extracted.map(e => e.paramId));
}

export function ambiguousIds(result: ExtractionResult): Set<string> {
  return new Set(result.ambiguous.map(a => a.paramId));
}

/** Build the "What I have" pill list for the UI acknowledgement. */
export interface AcknowledgementPill {
  paramId: string;
  label: string;             // human-readable, e.g. "$4B entry EV"
  source: ExtractionSource;
}

export function buildAcknowledgement(
  result: ExtractionResult,
  manifest: TaskManifest,
): AcknowledgementPill[] {
  const all = [...manifest.required, ...manifest.recommended, ...manifest.optional];
  const byId = new Map(all.map(p => [p.id, p]));
  return result.extracted.map(e => {
    const spec = byId.get(e.paramId);
    return {
      paramId: e.paramId,
      label: formatPillLabel(spec, e.value),
      source: e.source,
    };
  });
}

function formatPillLabel(spec: ParamSpec | undefined, value: ExtractedParam['value']): string {
  if (!spec) return String(value);
  if (spec.kind === 'numeric' && typeof value === 'number') {
    if (spec.unit?.includes('$M')) {
      return value >= 1000 ? `$${(value / 1000).toFixed(1)}B ${spec.label.toLowerCase()}` : `$${Math.round(value)}M ${spec.label.toLowerCase()}`;
    }
    return `${value}${spec.unit ? spec.unit.replace(/^x\s/, 'x ').trim() : ''} ${spec.label.toLowerCase()}`;
  }
  if (spec.kind === 'select' && typeof value === 'string') {
    const opt = spec.options?.find(o => o.value === value);
    return `${opt?.label ?? value} ${spec.label.toLowerCase()}`;
  }
  if (spec.kind === 'boolean') {
    return value ? `${spec.label}: yes` : `${spec.label}: no`;
  }
  if (Array.isArray(value)) {
    return `${spec.label}: ${value.join(', ')}`;
  }
  return `${spec.label}: ${String(value)}`;
}
