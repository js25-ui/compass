import type { TaskManifest, ValidationRule, DerivedFinancials } from './types';

const validation: ValidationRule[] = [
  {
    field: 'entry_ev',
    level: 'error',
    check: (scope) => {
      const v = Number(scope.entry_ev);
      if (!Number.isFinite(v) || v <= 0) return 'Entry EV is required and must be a positive number ($M).';
      return null;
    },
    suggestion: 'Provide entry EV in $M (e.g. 4000 for $4B).',
  },
  {
    field: 'entry_ev',
    level: 'error',
    check: (scope, derived) => {
      const ev = Number(scope.entry_ev);
      const ebitda = derived?.initialEbitdaM ?? null;
      if (!Number.isFinite(ev) || ev <= 0 || !ebitda || ebitda <= 0) return null;
      const m = ev / ebitda;
      if (m > 30) return `Entry EV implies ${m.toFixed(0)}x base-year EBITDA — outside the 5-30x sane range for sponsor LBOs.`;
      if (m < 5) return `Entry EV implies only ${m.toFixed(1)}x base-year EBITDA — below the 5-30x sane range.`;
      return null;
    },
    suggestion: 'Either revise entry EV or anchor to a different base-year EBITDA.',
  },
  {
    field: 'leverage_multiple',
    level: 'warn',
    check: (scope) => {
      const v = Number(scope.leverage_multiple);
      if (!Number.isFinite(v)) return null;
      if (v < 2) return `Leverage ${v.toFixed(1)}x — below sponsor norms (2-9x); deal looks more like a strategic / cash buyer setup.`;
      if (v > 9) return `Leverage ${v.toFixed(1)}x — above sponsor norms (2-9x); only stable cash flows support this.`;
      return null;
    },
  },
  {
    field: 'revenue_cagr',
    level: 'warn',
    check: (scope) => {
      const v = Number(scope.revenue_cagr);
      if (!Number.isFinite(v)) return null;
      const decimal = v > 1 ? v / 100 : v;
      if (decimal > 1.0) return `${(decimal * 100).toFixed(0)}% CAGR sustained is aggressive — stress at lower rates.`;
      if (decimal < -0.1) return `Negative CAGR over hold suggests structural decline; LBO thesis may be weak.`;
      return null;
    },
  },
  {
    field: 'exit_multiple',
    level: 'warn',
    check: (scope) => {
      const v = Number(scope.exit_multiple);
      if (!Number.isFinite(v)) return null;
      if (v < 5) return `Exit multiple ${v.toFixed(1)}x is well below typical sponsor exits (5-30x).`;
      if (v > 30) return `Exit multiple ${v.toFixed(1)}x is at the very top of the range — premium consumer / hyper-growth software territory.`;
      return null;
    },
  },
];

export const LBO_MANIFEST: TaskManifest = {
  taskType: 'lbo',
  label: 'LBO Analysis',
  description: 'Sponsor-led leveraged buyout with debt schedule, IRR/MOIC, and sensitivity grid.',
  required: [
    {
      id: 'entry_ev',
      label: 'Entry EV',
      prompt: 'Entry enterprise value — what level are we modeling against?',
      kind: 'numeric',
      default: 1000,
      unit: '$M',
      min: 50,
      max: 5_000_000,
      step: 25,
      hint: 'Enter $M (e.g. 4000 for $4B). Recommendation only — no cap.',
      oneOfGroup: 'entry_sizing',
    },
    {
      id: 'hold_period',
      label: 'Hold period',
      prompt: 'Hold period — how long is the sponsor underwriting?',
      kind: 'numeric',
      default: 5,
      unit: 'years',
      min: 1,
      max: 12,
      step: 1,
      hint: 'PE-typical 5y; infra / continuation funds run longer.',
    },
  ],
  recommended: [
    {
      id: 'leverage_multiple',
      label: 'Leverage',
      prompt: 'Leverage — turns of EBITDA on day one?',
      kind: 'numeric',
      default: 5.5,
      unit: 'x EBITDA',
      min: 2,
      max: 12,
      step: 0.25,
      hint: 'Sponsor LBO band 4-7x; ABL / asset-heavy plays go higher.',
    },
    {
      id: 'exit_multiple',
      label: 'Exit multiple',
      prompt: 'Exit multiple — what trading multiple do we underwrite at exit?',
      kind: 'numeric',
      default: 11.0,
      unit: 'x EBITDA',
      min: 5,
      max: 35,
      step: 0.5,
      hint: 'Premium consumer brands hit 20x+; commodity industrials under 8x. Recommendation only.',
    },
    {
      id: 'revenue_cagr',
      label: 'Revenue CAGR',
      prompt: 'Revenue CAGR over the hold — how do you want to model growth?',
      kind: 'numeric',
      default: 12,
      unit: '%',
      min: -10,
      max: 60,
      step: 1,
      hint: 'Mature consumer ~5%, growth tech 20-35%, hyper-growth higher.',
    },
    {
      id: 'exit_route',
      label: 'Exit route',
      prompt: 'Exit route assumption?',
      kind: 'select',
      default: 'ipo',
      options: [
        { value: 'ipo', label: 'IPO' },
        { value: 'strategic_sale', label: 'Strategic sale' },
        { value: 'continuation_fund', label: 'Continuation fund' },
        { value: 'dividend_recap', label: 'Dividend recap' },
      ],
    },
    {
      id: 'margin_trajectory',
      label: 'EBITDA margin trajectory',
      prompt: 'How does EBITDA margin evolve over the hold?',
      kind: 'select',
      default: 'flat',
      options: [
        { value: 'flat', label: 'Flat' },
        { value: 'expansion', label: 'Expansion' },
        { value: 'compression', label: 'Compression' },
      ],
    },
  ],
  optional: [
    {
      id: 'debt_structure',
      label: 'Debt structure',
      prompt: 'Specific debt structure?',
      kind: 'select',
      default: 'tlb_hy',
      options: [
        { value: 'tlb_only', label: 'TLB only' },
        { value: 'tlb_hy', label: 'TLB + HY' },
        { value: 'tlb_hy_mezz', label: 'TLB + HY + Mezz' },
      ],
    },
    {
      id: 'capex_pct_revenue',
      label: 'Capex / revenue',
      prompt: 'Capex intensity (default uses last 3Y avg)',
      kind: 'numeric',
      default: 5,
      unit: '%',
      min: 0,
      max: 40,
      step: 0.5,
    },
    {
      id: 'ai_disruption_overlay',
      label: 'AI-disruption overlay',
      prompt: 'Overlay AI-disruption risk in returns sensitivity?',
      kind: 'boolean',
      default: false,
      hint: 'Useful for Blackstone-style underwriting on software / services targets.',
    },
  ],
  validation,
  data: [
    { metric: 'revenue', period: 'annual_latest', required: true },
    { metric: 'ebitda', period: 'annual_latest', required: true },
    { metric: 'capex', period: 'annual_latest', required: false },
    { metric: 'long_term_debt', period: 'annual_latest', required: false },
    { metric: 'operating_income', period: 'annual_history_3', required: false },
  ],
};

export type { DerivedFinancials };
