import type { TaskManifest } from './types';

/**
 * Excel export is invoked as a follow-up on an existing LBO/DCF run.
 * No scope-card answers are required — the export carries forward
 * prior_context.scope (which includes the underlying model's pure-function
 * inputs as `_model_*` keys) and generates a downloadable .xlsx.
 *
 * The manifest exists so the classifier doesn't fall through to the
 * generic placeholder when the user says "export to excel".
 */
export const EXCEL_MODEL_MANIFEST: TaskManifest = {
  taskType: 'excel_model',
  label: 'Excel Export',
  description: 'Static-value .xlsx of a completed model run (LBO or DCF) — Inputs, Model, Outputs, Sensitivity, Sources tabs with citations as cell comments.',
  required: [],
  recommended: [],
  optional: [],
  validation: [],
  data: [],
};
