import type { TaskManifest } from './types';

export const TRADING_COMPS_MANIFEST: TaskManifest = {
  taskType: 'trading_comps',
  label: 'Trading Comparables',
  description: 'Public-market peer set with revenue / margin / multiple benchmarking against the target.',
  required: [
    {
      id: 'comp_universe_scope',
      label: 'Comp universe scope',
      prompt: 'How tight should the comp set be?',
      kind: 'select',
      default: 'sector_plus',
      options: [
        { value: 'sector_pure', label: 'Sector tight (same SIC/GIC code)' },
        { value: 'sector_plus', label: 'Sector + adjacent sub-sectors' },
        { value: 'broad', label: 'Broad industry / alternative comps' },
        { value: 'custom', label: 'Custom list (provide tickers)' },
      ],
    },
  ],
  recommended: [
    {
      id: 'num_comps',
      label: 'Number of peers',
      prompt: 'How many peers in the comp set?',
      kind: 'numeric',
      default: 8,
      unit: 'companies',
      min: 4,
      max: 25,
      step: 1,
      hint: 'Typical 8-12; 4 minimum for medians to be meaningful.',
    },
    {
      id: 'time_period',
      label: 'Time period',
      prompt: 'LTM, NTM, or both?',
      kind: 'select',
      default: 'both',
      options: [
        { value: 'ltm', label: 'LTM only' },
        { value: 'ntm', label: 'NTM only' },
        { value: 'both', label: 'LTM + NTM' },
      ],
    },
    {
      id: 'metrics_focus',
      label: 'Multiples to include',
      prompt: 'Which multiples?',
      kind: 'multi_select',
      default: ['ev_revenue', 'ev_ebitda', 'pe'],
      options: [
        { value: 'ev_revenue', label: 'EV / Revenue' },
        { value: 'ev_ebitda', label: 'EV / EBITDA' },
        { value: 'pe', label: 'P/E' },
        { value: 'pb', label: 'P/B' },
        { value: 'ev_ebit', label: 'EV / EBIT' },
      ],
    },
    {
      id: 'geographic_scope',
      label: 'Geography',
      prompt: 'Geographic scope?',
      kind: 'select',
      default: 'us_only',
      options: [
        { value: 'us_only', label: 'US only' },
        { value: 'global', label: 'Global' },
        { value: 'developed', label: 'Developed markets' },
      ],
    },
  ],
  optional: [
    {
      id: 'exclude_distressed',
      label: 'Exclude distressed names',
      prompt: 'Drop distressed / pre-bankruptcy names from the set?',
      kind: 'boolean',
      default: true,
    },
    {
      id: 'exclude_ma_targets',
      label: 'Exclude pending M&A',
      prompt: 'Drop names with pending M&A from the set (multiples are skewed)?',
      kind: 'boolean',
      default: true,
    },
    {
      id: 'market_cap_band',
      label: 'Market cap band',
      prompt: 'Market cap band relative to target',
      kind: 'select',
      default: 'similar',
      options: [
        { value: 'similar', label: '0.5–2x target market cap' },
        { value: 'wider', label: '0.25–4x target market cap' },
        { value: 'all', label: 'All sizes' },
      ],
    },
  ],
  validation: [
    {
      field: 'num_comps',
      level: 'error',
      check: (scope) => {
        const n = Number(scope.num_comps ?? 8);
        if (!Number.isFinite(n) || n < 4) return 'At least 4 comps are required for medians to be meaningful.';
        if (n > 25) return 'More than 25 comps starts losing signal — narrow the set.';
        return null;
      },
    },
    {
      field: 'metrics_focus',
      level: 'error',
      check: (scope) => {
        const list = Array.isArray(scope.metrics_focus) ? scope.metrics_focus : [];
        if (list.length === 0) return 'Pick at least one multiple to compare on.';
        return null;
      },
    },
  ],
  data: [
    { metric: 'revenue', period: 'annual_latest', required: false },
  ],
};
