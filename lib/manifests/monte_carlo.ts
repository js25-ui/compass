import type { TaskManifest } from './types';

/**
 * Monte Carlo overlay manifest.
 *
 * The actual per-variable distribution parameters are gathered via free-form
 * text in the scope card (e.g. "leverage_multiple: normal(5.5, 0.8)") because
 * a multi-parameter-per-variable scope card is more clarification UI than
 * we want to build right now. The pipeline parses these strings into
 * DistributionSpec objects and refuses cleanly if anything's malformed.
 */
export const MONTE_CARLO_MANIFEST: TaskManifest = {
  taskType: 'monte_carlo',
  label: 'Monte Carlo Overlay',
  description: 'Run an existing LBO or DCF model thousands of times with sampled inputs to produce an outcome distribution.',
  required: [
    {
      id: 'underlying_model',
      label: 'Underlying model',
      prompt: 'Which model should the Monte Carlo overlay run on top of?',
      kind: 'select',
      default: 'lbo',
      options: [
        { value: 'lbo', label: 'LBO (overlays IRR distribution)' },
        { value: 'dcf', label: 'DCF (overlays enterprise-value distribution)' },
      ],
    },
    {
      id: 'distributions',
      label: 'Stochastic variables + distributions',
      prompt: 'Which inputs vary, and with what distribution? One per line: "field: normal(mean, stdev)" / "uniform(min, max)" / "triangular(min, mode, max)". Field names match the underlying model.',
      kind: 'text',
      hint: 'Example for LBO:\nleverage_multiple: normal(5.5, 0.8)\nrevenueCAGR: triangular(0.05, 0.10, 0.18)\nexitMultiple: uniform(9, 13)',
    },
  ],
  recommended: [
    {
      id: 'trial_count',
      label: 'Trial count',
      prompt: 'How many simulated trials?',
      kind: 'numeric',
      default: 10000,
      min: 100,
      max: 50000,
      step: 100,
      unit: 'trials',
    },
    {
      id: 'random_seed',
      label: 'Random seed',
      prompt: 'Seed for reproducibility (default 42 — runs with the same seed produce identical results).',
      kind: 'numeric',
      default: 42,
      min: 0,
      max: 2_000_000_000,
      step: 1,
    },
    {
      id: 'hurdle',
      label: 'Hurdle (for prob-of-beating)',
      prompt: 'IRR hurdle for LBO (decimal, e.g. 0.20 for 20%) or EV hurdle for DCF ($M). Leave blank to skip.',
      kind: 'numeric',
    },
  ],
  optional: [],
  validation: [
    {
      field: 'distributions',
      level: 'error',
      check: (scope) => {
        const text = String(scope.distributions ?? '').trim();
        if (!text) return 'Specify at least one stochastic variable.';
        return null;
      },
    },
    {
      field: 'trial_count',
      level: 'error',
      check: (scope) => {
        const n = Number(scope.trial_count ?? 10000);
        if (!Number.isFinite(n) || n < 100) return 'Trial count must be ≥100 for stable statistics.';
        if (n > 50000) return 'Trial count capped at 50,000 to keep response time reasonable.';
        return null;
      },
    },
  ],
  data: [],
};
