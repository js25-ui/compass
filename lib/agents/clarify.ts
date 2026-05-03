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
  id: string;               // stable key, e.g. "leverage"
  prompt: string;           // the question, in analyst voice
  kind: 'select' | 'multi_select' | 'numeric' | 'text' | 'boolean';
  default?: string | number | boolean;
  options?: ClarifyOption[];// for select / multi_select
  unit?: string;            // for numeric (e.g. "x EBITDA", "%", "$M", "years", "bps")
  min?: number;             // for numeric — soft validation (warn if outside)
  max?: number;             // for numeric — soft validation (warn if outside)
  step?: number;            // for numeric — UI increment hint (e.g. 0.5)
  hint?: string;            // optional sub-line under the prompt (range/example)
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
  "default": <value matching the kind>,
  "options": [{"value": "...", "label": "..."}],  // required for select / multi_select
  "unit": "...",                                    // REQUIRED for numeric (e.g. "x EBITDA", "%", "$M", "years", "bps")
  "min": <number>,                                  // for numeric — soft range floor
  "max": <number>,                                  // for numeric — soft range ceiling
  "step": <number>,                                 // for numeric — UI increment (e.g. 0.5)
  "hint": "<optional one-line context, e.g. 'typical 5-7x for IG-sponsored buyouts'>"
}

INPUT TYPE PICKING — strictly enforced:

Use 'select' (dropdown) when:
- 2-5 categorically DIFFERENT options where each changes the STRUCTURE of the analysis, not just a number on a continuous axis.
- Right uses: hold period (3Y / 5Y / 7Y), exit route (IPO / strategic sale / continuation), business line (ECM / DCM / Alts), scenario type (Bear / Base / Bull), comp universe scope (sector pure / sector + adjacent / broad), sponsor type (PE / strategic / both).

Use 'numeric' (typed input) when:
- A continuous parameter where any value in a range is valid and the user might want precision.
- Right uses: leverage multiple, entry multiple, exit multiple, revenue CAGR, EBITDA margin, discount rate / WACC, tenor in years, target equity check, hold period in months when granular.
- WRONG to use 'select' here: leverage as 4x / 5x / 6x / 7x dropdown is the wrong type. So is CAGR as "Conservative / Moderate / Aggressive". Use numeric.

Use 'text' when:
- Open-ended qualitative input. Examples: "Any specific risks to emphasize?", "Key thesis points?"

Use 'boolean' when:
- A yes/no decision. Examples: "Include LBO scenario?", "Include DCF?"

Use 'multi_select' when:
- A small set of categorically different choices, multiple of which can apply. Example: metric emphasis (valuation / growth / profitability / returns).

Every 'numeric' question MUST include: default (number), unit, min, max. Use a step when round numbers aren't natural (e.g. leverage 0.25x).

General rules:

- Cap questions at the 2-4 most material decisions. NEVER list every possible parameter — that's a checklist, not a scope conversation. Pick what most changes the deliverable.

- Phrase like an associate, not a form: "Leverage — typical 6x for sponsor LBOs in this space, or stretch?"  not  "Leverage multiple:"

- Sensible defaults reflect typical desk practice:
    Pitch book   → 8 trading comps; 5y precedent window; sponsor + strategic buyer universe; LBO included.
    IC memo      → growth + defensibility thesis priority; market + financial risk emphasis.
    Bond pricing → 10Y tenor for IG corp; 12-month comp window; base + tight + wide rate scenarios.
    LBO          → 5-year hold; 6.0x leverage (numeric); 11.0x exit multiple (numeric); 25% revenue CAGR for growth tech, 8% for mature.
    IPO pricing  → 8 public peers (numeric); 18-month precedent window (numeric, in months).
    Trading comps→ 8 peers (numeric); LTM + NTM metric set (multi_select).

QUESTION SETS BY TASK TYPE — each task type has its own input set. Pick the matching set verbatim. Emit every listed input even if the user's query mentions a value (use the mentioned value as the default, but ALWAYS surface the field so the user can confirm or revise). Don't pile every parameter into every deliverable — only the deal-shaping inputs that the analyst would actually want to lock down.

  lbo_analysis (Sponsor LBO):
    1. entry_ev          (numeric, $M, REQUIRED — extract from query if mentioned, else size to target scale)
    2. hold_period       (numeric, years)
    3. leverage_multiple (numeric, x EBITDA)
    4. revenue_cagr      (numeric, %)
    5. exit_multiple     (numeric, x EBITDA)

  ipo_pricing:
    1. proposed_price_low  (numeric, $)
    2. proposed_price_high (numeric, $)
    3. num_peers           (numeric, count)
    4. precedent_window_months (numeric, months)

  bond_pricing:
    1. tenor_years        (numeric, years)
    2. issue_size_m       (numeric, $M)
    3. comp_window_months (numeric, months)
    4. rating_override    (select with 'use issuer current' default + AAA/AA/A/BBB/BB/B/CCC choices)

  trading_comps:
    1. num_comps             (numeric, peers count)
    2. comp_universe_scope   (select: sector_pure / sector_plus / broad)
    3. metrics_focus         (multi_select: valuation / growth / profitability / returns)

  precedents (Precedent Transactions):
    1. num_precedents          (numeric)
    2. precedent_window_months (numeric, months)
    3. deal_size_min_m         (numeric, $M)
    4. buyer_type              (select: sponsor / strategic / both)

  ic_memo:
    1. thesis_priority   (select: growth / margin / defensibility / capital_returns)
    2. risk_emphasis     (multi_select: financial / market / regulatory / ai_disruption / execution)
    3. returns_depth     (select: light / standard / deep)

  pitch_book:
    1. pitch_focus      (select: follow_on / sell_side_ma / buy_side_ma / strategic_overview)
    2. num_comps        (numeric)
    3. comp_universe_scope (select: pure_play / sector_plus / broad)
    4. num_precedents   (numeric)
    5. include_lbo      (boolean)

  dcf:
    1. discount_rate          (numeric, %)
    2. terminal_growth_rate   (numeric, %)
    3. projection_years       (numeric, years)
    4. terminal_method        (select: gordon_growth / exit_multiple)

CAPS POLICY: min/max on numeric questions are RECOMMENDATIONS, not hard limits. The UI shows them as "typical X-Y" hints and surfaces a soft warning when the user's value is outside, but never blocks submission. Set honest typical ranges and let the user override. Do not artificially compress the upper bound to keep the user "in line" — the analyst should be free to model an aggressive case (high-growth consumer at 25x exit, GPU infra at 6x leverage, etc.).

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
  const parsed = parseClarifyOutput(text);
  return enforceMandatoryQuestions(parsed, query);
}

/**
 * Belt-and-suspenders: even when the prompt declares mandatory questions,
 * Sonnet sometimes drops one (typically when the query already mentions the
 * value). This post-processing layer guarantees the canonical set is present
 * for every task type. Existing Sonnet questions are kept verbatim; missing
 * ones are appended with sensible defaults.
 */
function enforceMandatoryQuestions(out: ClarifyOutput, query: string): ClarifyOutput {
  if (out.task_type === 'chat_answer' || out.ready_to_proceed) return out;

  const required = REQUIRED_QUESTIONS[out.task_type];
  if (!required) return out;

  const existing = new Set(out.questions.map(q => q.id));
  const additions: ClarifyQuestion[] = [];
  for (const r of required) {
    if (existing.has(r.id)) continue;
    additions.push(r.build(query));
  }
  if (additions.length > 0) {
    return {
      ...out,
      questions: [...additions, ...out.questions],     // prepend so required show up first
      ready_to_proceed: false,
    };
  }
  return out;
}

interface RequiredQuestionSpec {
  id: string;
  build: (query: string) => ClarifyQuestion;
}

const REQUIRED_QUESTIONS: Partial<Record<TaskType, RequiredQuestionSpec[]>> = {
  lbo_analysis: [
    {
      id: 'entry_ev',
      build: query => ({
        id: 'entry_ev',
        prompt: 'Entry enterprise value — what level are we modeling against?',
        kind: 'numeric',
        default: extractDollarsFromQueryToM(query) ?? 1000,
        unit: '$M',
        min: 50,
        max: 5_000_000,
        step: 25,
        hint: 'Enter $M (e.g. 1200 for $1.2B, 50000 for $50B). Recommended only — not a cap.',
      }),
    },
    {
      id: 'hold_period',
      build: () => ({ id: 'hold_period', prompt: 'Hold period — how long is the sponsor underwriting?', kind: 'numeric', default: 5, unit: 'years', min: 1, max: 12, step: 1, hint: 'PE-typical 5y; infra / continuation funds run longer.' }),
    },
    {
      id: 'leverage_multiple',
      build: () => ({ id: 'leverage_multiple', prompt: 'Leverage — turns of EBITDA on day one?', kind: 'numeric', default: 5.5, unit: 'x EBITDA', min: 2, max: 12, step: 0.25, hint: 'Sponsor LBO band 4-7x; ABL / asset-heavy plays go higher.' }),
    },
    {
      id: 'revenue_cagr',
      build: () => ({ id: 'revenue_cagr', prompt: 'Revenue CAGR over the hold — how do you want to model growth?', kind: 'numeric', default: 12, unit: '%', min: -10, max: 60, step: 1, hint: 'Mature consumer ~5%, growth tech 20-35%, hyper-growth higher.' }),
    },
    {
      id: 'exit_multiple',
      build: () => ({ id: 'exit_multiple', prompt: 'Exit multiple — what trading multiple do we underwrite at exit?', kind: 'numeric', default: 11.0, unit: 'x EBITDA', min: 5, max: 35, step: 0.5, hint: 'Premium consumer brands hit 20x+; commodity industrials under 8x. Recommendation only.' }),
    },
  ],
};

function extractDollarsFromQueryToM(q: string): number | null {
  const tMatch = q.match(/\$\s*([\d.]+)\s*T(?:r|rillion)?\b/i);
  if (tMatch) return Math.round(parseFloat(tMatch[1]) * 1_000_000);
  const bMatch = q.match(/\$\s*([\d.]+)\s*B(?:n|illion)?\b/i);
  if (bMatch) return Math.round(parseFloat(bMatch[1]) * 1000);
  const mMatch = q.match(/\$\s*([\d,.]+)\s*M(?:M|illion)?\b/i);
  if (mMatch) return Math.round(parseFloat(mMatch[1].replace(/,/g, '')));
  return null;
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
