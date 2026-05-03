import type { TaskManifest } from './types';

export const PRECEDENTS_MANIFEST: TaskManifest = {
  taskType: 'precedents',
  label: 'Precedent Transactions',
  description: 'M&A precedent analysis with multiples, premium, and read-through to the target.',
  required: [
    {
      id: 'time_window_years',
      label: 'Time window',
      prompt: 'Lookback window?',
      kind: 'select',
      default: '5',
      options: [
        { value: '1', label: '1 year' },
        { value: '3', label: '3 years' },
        { value: '5', label: '5 years' },
        { value: '10', label: '10 years' },
      ],
    },
  ],
  recommended: [
    {
      id: 'deal_size_min_m',
      label: 'Minimum deal size',
      prompt: 'Smallest deal to include',
      kind: 'numeric',
      default: 500,
      unit: '$M',
      min: 50,
      max: 50000,
      step: 50,
    },
    {
      id: 'deal_types',
      label: 'Deal types',
      prompt: 'Which deal types?',
      kind: 'multi_select',
      default: ['strategic', 'sponsor_lbo'],
      options: [
        { value: 'strategic', label: 'Strategic' },
        { value: 'sponsor_lbo', label: 'Sponsor LBO' },
        { value: 'going_private', label: 'Going Private' },
        { value: 'public_merger', label: 'Public Merger' },
        { value: 'ipo', label: 'IPO' },
      ],
    },
    {
      id: 'sector_scope',
      label: 'Sector scope',
      prompt: 'Sector tightness',
      kind: 'select',
      default: 'tight',
      options: [
        { value: 'tight', label: 'Tight (same sub-sector)' },
        { value: 'broad', label: 'Broad (sector + adjacent)' },
        { value: 'industry', label: 'Full industry' },
      ],
    },
  ],
  optional: [],
  validation: [],
  data: [],
};
