/**
 * Task manifests describe what a deliverable needs from the user before it
 * runs. Each manifest declares parameters at three tiers:
 *
 *   - required:     model can't run without these; clarification blocks
 *   - recommended:  surfaced with sensible defaults; user can override
 *   - optional:     hidden by default behind "advanced options"
 *
 * Plus validation rules (range checks, mutual-exclusion, conditional
 * requirements) and lightweight metadata about the data the model needs to
 * gather (which links into the financial_facts preflight system).
 *
 * The Parameter Extraction Agent reads the manifest to know what fields to
 * look for in the user's natural-language prompt; the clarification UI uses
 * it to render only the still-missing inputs.
 */

export type TaskType =
  | 'lbo'
  | 'dcf'
  | 'trading_comps'
  | 'precedents'
  | 'ipo_valuation'
  | 'bond_pricing'
  | 'monte_carlo'
  | 'football_field'
  | 'ic_memo'
  | 'pitch_book'
  | 'excel_model'
  | 'sector_screen'
  | 'chat_answer';

export type ParamKind = 'numeric' | 'select' | 'multi_select' | 'boolean' | 'text';

export interface ParamOption {
  value: string;
  label: string;
}

export interface ParamSpec {
  /** stable snake_case key, used as the scope answer key */
  id: string;
  /** human-friendly label shown in the scope card */
  label: string;
  /** longer prompt used in the form; analyst voice */
  prompt: string;
  kind: ParamKind;
  /** Default value. For dynamic defaults that depend on context, the orchestrator
   *  may override at runtime. */
  default?: string | number | boolean | string[];
  /** Optional unit shown next to numeric inputs */
  unit?: string;
  /** Recommendation range for numeric — soft, not enforced. */
  min?: number;
  max?: number;
  step?: number;
  /** One-line context shown under the prompt */
  hint?: string;
  /** For select / multi_select. */
  options?: ParamOption[];
  /** Optional one-of-N group: at least one of these param IDs must be present.
   *  Example: LBO entry sizing — entry_ev OR entry_multiple, not both. */
  oneOfGroup?: string;
  /** Show this param only when context flags it (e.g. M&A roll-up thesis). */
  conditional?: (ctx: ManifestContext) => boolean;
}

export interface ValidationRule {
  /** Param id this rule applies to (or '*' for cross-field). */
  field: string;
  level: 'error' | 'warn';
  /** Returns null if OK, else a message. */
  check: (scope: Record<string, unknown>, derived: DerivedFinancials | null) => string | null;
  /** Recommendation surfaced when the rule fires. */
  suggestion?: string;
}

export interface DerivedFinancials {
  initialRevenueM: number | null;
  initialEbitdaM: number | null;
  ebitdaMargin: number | null;
}

export interface ManifestContext {
  query: string;
  detectedTarget?: { name: string; ticker?: string } | null;
  dealType?: string;
}

export interface DataRequirement {
  metric: string;             // e.g. 'revenue', 'ebitda'
  period?: 'LTM' | 'annual_latest' | 'annual_history_3' | 'annual_history_5';
  required: boolean;
}

export interface TaskManifest {
  taskType: TaskType;
  /** Display name for the scope card title. */
  label: string;
  /** Plain English description for orchestrator routing prompts. */
  description: string;
  /** All parameters across the three tiers. */
  required: ParamSpec[];
  recommended: ParamSpec[];
  optional: ParamSpec[];
  /** Validation rules applied after extraction + user input. */
  validation: ValidationRule[];
  /** What the model needs from the corpus / XBRL. */
  data: DataRequirement[];
}

export function allParamsOf(manifest: TaskManifest): ParamSpec[] {
  return [...manifest.required, ...manifest.recommended, ...manifest.optional];
}

export function paramById(manifest: TaskManifest, id: string): ParamSpec | null {
  for (const p of allParamsOf(manifest)) if (p.id === id) return p;
  return null;
}
