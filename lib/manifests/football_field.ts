import type { TaskManifest } from './types';

export const FOOTBALL_FIELD_MANIFEST: TaskManifest = {
  taskType: 'football_field',
  label: 'Football Field Valuation',
  description: 'Stacked-bar visualization of implied valuation ranges across multiple methodologies, with the overlap zone called out as the implied fair-value band.',
  required: [
    {
      id: 'methodologies',
      label: 'Methodologies to include',
      prompt: 'Which valuation methods should the football field stack?',
      kind: 'multi_select',
      default: ['trading_comps', 'precedents', 'dcf_range', 'fifty_two_week', 'analyst_targets'],
      options: [
        { value: 'trading_comps', label: 'Trading comparables' },
        { value: 'precedents', label: 'Precedent transactions' },
        { value: 'dcf_range', label: 'DCF (sensitivity-grid range)' },
        { value: 'lbo_range', label: 'LBO (IRR-feasible entry range)' },
        { value: 'fifty_two_week', label: '52-week trading range' },
        { value: 'analyst_targets', label: 'Analyst price targets' },
      ],
      hint: 'Need at least 2 methodologies for the overlap zone to be meaningful.',
    },
    {
      id: 'axis_basis',
      label: 'Y-axis basis',
      prompt: 'What units should the bars be in?',
      kind: 'select',
      default: 'equity_value',
      options: [
        { value: 'share_price', label: 'Share price ($)' },
        { value: 'equity_value', label: 'Equity value ($M)' },
        { value: 'enterprise_value', label: 'Enterprise value ($M)' },
      ],
    },
  ],
  recommended: [],
  optional: [],
  validation: [
    {
      field: 'methodologies',
      level: 'error',
      check: (scope) => {
        const list = Array.isArray(scope.methodologies) ? scope.methodologies : [];
        if (list.length < 2) return 'Pick at least 2 methodologies — the football field needs ranges to compare.';
        return null;
      },
    },
  ],
  data: [],
};
