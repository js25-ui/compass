import type { TaskManifest } from './types';

export const IPO_VALUATION_MANIFEST: TaskManifest = {
  taskType: 'ipo_valuation',
  label: 'IPO Valuation',
  description: 'Comp-based valuation range for an IPO target plus Day-1 distribution.',
  required: [
    {
      id: 'pricing_scenario',
      label: 'Pricing scenario',
      prompt: 'Which scenario are we anchoring to?',
      kind: 'select',
      default: 'base',
      options: [
        { value: 'conservative', label: 'Conservative (low end of comp range)' },
        { value: 'base', label: 'Base (comp median)' },
        { value: 'aggressive', label: 'Aggressive (high end / premium)' },
      ],
    },
  ],
  recommended: [
    {
      id: 'num_peers',
      label: 'Number of peers',
      prompt: 'How many public peers in the comp set?',
      kind: 'numeric',
      default: 8,
      unit: 'peers',
      min: 3,
      max: 20,
      step: 1,
      hint: 'Recent IPOs in the same sector are most pricing-relevant.',
    },
    {
      id: 'precedent_window_months',
      label: 'Precedent window',
      prompt: 'Lookback for IPO precedents (months)',
      kind: 'numeric',
      default: 18,
      unit: 'months',
      min: 6,
      max: 60,
      step: 3,
    },
    {
      id: 'pricing_anchor',
      label: 'Forward multiple anchor',
      prompt: 'Which multiple anchors the implied range?',
      kind: 'select',
      default: 'mixed',
      options: [
        { value: 'ev_revenue', label: 'EV / NTM Revenue' },
        { value: 'ev_ebitda', label: 'EV / NTM EBITDA' },
        { value: 'pe', label: 'P/E NTM' },
        { value: 'mixed', label: 'Mixed (median across)' },
      ],
    },
    {
      id: 'lockup_days',
      label: 'Lockup period',
      prompt: 'Lockup days?',
      kind: 'select',
      default: '180',
      options: [
        { value: '90', label: '90 days' },
        { value: '180', label: '180 days (standard)' },
        { value: '360', label: '360 days' },
      ],
    },
  ],
  optional: [
    {
      id: 'greenshoe_pct',
      label: 'Greenshoe',
      prompt: 'Greenshoe size (%)',
      kind: 'numeric',
      default: 15,
      unit: '%',
      min: 0,
      max: 25,
      step: 1,
    },
  ],
  validation: [
    {
      field: 'num_peers',
      level: 'error',
      check: (scope) => {
        const n = Number(scope.num_peers ?? 8);
        if (n < 3) return 'At least 3 viable comparables are required to anchor an IPO range.';
        return null;
      },
    },
  ],
  data: [{ metric: 'revenue', period: 'annual_history_3', required: true }],
};
