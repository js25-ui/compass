import type { TaskManifest } from './types';

export const DCF_MANIFEST: TaskManifest = {
  taskType: 'dcf',
  label: 'DCF Valuation',
  description: 'Discounted cash flow with explicit projection period and terminal value.',
  required: [
    {
      id: 'projection_years',
      label: 'Projection period',
      prompt: 'Projection horizon?',
      kind: 'select',
      default: '5',
      options: [
        { value: '5', label: '5 years' },
        { value: '10', label: '10 years' },
      ],
    },
    {
      id: 'wacc_method',
      label: 'WACC methodology',
      prompt: 'How are we deriving WACC?',
      kind: 'select',
      default: 'computed',
      options: [
        { value: 'computed', label: 'WACC computed (CAPM + capital structure)' },
        { value: 'manual', label: 'Manual WACC override' },
      ],
    },
  ],
  recommended: [
    {
      id: 'discount_rate',
      label: 'Discount rate (if manual)',
      prompt: 'WACC override (only if manual)',
      kind: 'numeric',
      default: 9,
      unit: '%',
      min: 4,
      max: 18,
      step: 0.25,
    },
    {
      id: 'terminal_growth_rate',
      label: 'Terminal growth',
      prompt: 'Terminal growth rate (Gordon Growth)',
      kind: 'numeric',
      default: 2.5,
      unit: '%',
      min: 0,
      max: 5,
      step: 0.25,
    },
    {
      id: 'terminal_method',
      label: 'Terminal method',
      prompt: 'Terminal value approach',
      kind: 'select',
      default: 'gordon_growth',
      options: [
        { value: 'gordon_growth', label: 'Gordon Growth (perpetuity)' },
        { value: 'exit_multiple', label: 'Exit Multiple' },
      ],
    },
    {
      id: 'tax_rate',
      label: 'Tax rate',
      prompt: 'Effective tax rate',
      kind: 'numeric',
      default: 25,
      unit: '%',
      min: 0,
      max: 40,
      step: 1,
    },
    {
      id: 'revenue_cagr',
      label: 'Projected revenue CAGR',
      prompt: 'Projected revenue CAGR (overrides historical CAGR when set)',
      kind: 'numeric',
      unit: '%',
      min: -10,
      max: 80,
      step: 0.5,
    },
    {
      id: 'ebit_margin',
      label: 'Projected EBIT (operating) margin',
      prompt: 'Projected EBIT margin held flat across the forecast (overrides historical base margin when set)',
      kind: 'numeric',
      unit: '%',
      min: -50,
      max: 80,
      step: 0.5,
    },
    {
      id: 'capex_pct_revenue',
      label: 'Capex / revenue',
      prompt: 'Capex as % of revenue (overrides historical when set)',
      kind: 'numeric',
      unit: '%',
      min: 0,
      max: 30,
      step: 0.25,
    },
    {
      id: 'nwc_pct_revenue',
      label: 'ΔNWC / Δrevenue',
      prompt: 'Change in net working capital as % of incremental revenue',
      kind: 'numeric',
      unit: '%',
      min: -20,
      max: 30,
      step: 0.25,
    },
  ],
  optional: [],
  validation: [
    {
      field: '*',
      level: 'error',
      check: (scope) => {
        const wacc = Number(scope.discount_rate ?? 9) / 100;
        const g = Number(scope.terminal_growth_rate ?? 2.5) / 100;
        if (g >= wacc) return `Terminal growth (${(g * 100).toFixed(1)}%) must be below WACC (${(wacc * 100).toFixed(1)}%) for Gordon Growth to converge.`;
        return null;
      },
    },
  ],
  data: [
    { metric: 'revenue', period: 'annual_history_5', required: true },
    { metric: 'operating_income', period: 'annual_history_5', required: true },
    { metric: 'capex', period: 'annual_history_3', required: false },
  ],
};
