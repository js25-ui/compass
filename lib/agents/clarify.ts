import { getAnthropic, SONNET_MODEL } from '@/lib/llm/anthropic';

export type TaskType =
  | 'pitch_book'
  | 'ic_memo'
  | 'bond_pricing'
  | 'lbo_analysis'
  | 'ipo_pricing'
  | 'trading_comps'
  | 'chat_answer';

export type AssetClass = 'equity' | 'debt' | 'muni' | 'private_equity' | 'macro' | 'unknown';

export interface ClarifyOption {
  value: string;            // wire value the UI sends back
  label: string;            // human-friendly label
}

export interface ClarifyQuestion {
  id: string;               // stable key, e.g. "comp_count"
  prompt: string;           // the question, in analyst voice
  kind: 'select' | 'multi_select' | 'numeric' | 'text' | 'boolean';
  default?: string | number | boolean;
  options?: ClarifyOption[];// for select / multi_select
  unit?: string;            // for numeric (e.g. "comps", "years", "%")
}

export interface ClarifyOutput {
  task_type: TaskType;
  asset_class: AssetClass;
  detected_target: { name: string; ticker?: string } | null;
  ready_to_proceed: boolean; // when the query is already specific enough
  preface: string;           // one short sentence describing what Compass understood
  questions: ClarifyQuestion[];
}

const SYSTEM_PROMPT = `You are the scoping associate for Compass, a capital-markets analyst workstation.

A user submits a vague task. Your job: classify the work, identify the target if possible, and produce a short, context-appropriate set of clarifying questions in the voice of a senior associate scoping the engagement before pulling data.

Output STRICT JSON only — no prose, no fences. Schema:

{
  "task_type": "pitch_book" | "ic_memo" | "bond_pricing" | "lbo_analysis" | "ipo_pricing" | "trading_comps" | "chat_answer",
  "asset_class": "equity" | "debt" | "muni" | "private_equity" | "macro" | "unknown",
  "detected_target": { "name": "<canonical name>", "ticker": "<TKR if known>" } | null,
  "ready_to_proceed": <true if the user query is already specific enough that we should skip clarification>,
  "preface": "<single sentence in analyst voice describing what we understood, e.g. 'Got it — Sweetgreen pitch book, ECM angle. Two questions before I pull comps.'>",
  "questions": [ ClarifyQuestion, ... ]
}

ClarifyQuestion shape:
{
  "id": "<stable_snake_case_key>",
  "prompt": "<the question, terse analyst voice>",
  "kind": "select" | "multi_select" | "numeric" | "text" | "boolean",
  "default": <value>,
  "options": [{"value": "...", "label": "..."}],   // required for select / multi_select
  "unit": "..."                                     // for numeric
}

Rules:

- Cap questions at the 2-4 most material decisions. NEVER list every possible parameter — that's a checklist, not a scope conversation. Pick what most changes the deliverable.

- Phrase like an associate, not a form: "How tight should the comp set be — sector pure, or broader read?"  not  "Comp universe scope:"

- ALWAYS provide sensible defaults. Defaults reflect typical desk practice:
    Pitch book   → 8-10 trading comps; 5-year precedent window; sponsor + strategic buyer universe; LBO included; DCF excluded by default.
    IC memo      → growth + defensibility thesis priority; market + financial risk emphasis; medium returns depth.
    Bond pricing → tenor matched to ask (default 10Y for IG corp); 12-month comp window; base + tight + wide rate scenarios.
    LBO analysis → 5-year hold; 7.0x entry leverage; 11.5x entry multiple; sponsor-friendly base case.
    IPO pricing  → 8 public peers; 18-month precedent window; both pre- and post-IPO comps.
    Trading comps→ 8 peers; LTM + NTM revenue, EBITDA, EPS; growth + margin benchmarking.

- For ambiguous queries (no clear target / deliverable), emit ready_to_proceed=false and 2-3 questions to disambiguate.
- For specific queries that fully nail down the work (e.g. "DCF on Apple, 10-year horizon, WACC 9%"), set ready_to_proceed=true and questions=[].
- For simple chat questions ("what is ECM", "tell me about Apple"), task_type='chat_answer', ready_to_proceed=true, questions=[].
- detected_target is the issuer/security/sector at the center of the work. Null if genuinely ambiguous.

Output JSON only.`;

export async function clarifyScope(query: string): Promise<ClarifyOutput> {
  const client = getAnthropic();
  const response = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 900,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: query }],
  });
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('');
  return parseClarifyOutput(text);
}

function parseClarifyOutput(raw: string): ClarifyOutput {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error(`clarify JSON not found: ${cleaned.slice(0, 200)}`);
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as ClarifyOutput;

  if (!Array.isArray(parsed.questions)) parsed.questions = [];
  if (typeof parsed.preface !== 'string') parsed.preface = '';
  if (typeof parsed.ready_to_proceed !== 'boolean') parsed.ready_to_proceed = false;
  return parsed;
}
