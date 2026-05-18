import type { TaskManifest } from './types';

export const SECTOR_SCREEN_MANIFEST: TaskManifest = {
  taskType: 'sector_screen',
  label: 'Sector Screen',
  description: 'Identify the top N companies in a sector by LTM revenue and produce a comparative summary across them.',
  required: [
    {
      id: 'sector',
      label: 'Sector',
      prompt: 'Which sector? (e.g. REITs, semiconductors, airlines)',
      kind: 'text',
      hint: 'Industry / sector label — pipeline maps it to SEC SIC code or a curated constituent list.',
    },
  ],
  recommended: [
    {
      id: 'top_n',
      label: 'How many to show',
      prompt: 'Top N companies (capped at 5)',
      kind: 'numeric',
      default: 5,
      unit: '',
      min: 1,
      max: 5,
      step: 1,
    },
    {
      id: 'metrics_focus',
      label: 'Metrics emphasized',
      prompt: 'What financials to highlight (revenue, margins, growth, EBITDA)',
      kind: 'text',
      default: 'revenue, growth, margins',
    },
  ],
  optional: [],
  validation: [],
  data: [
    { metric: 'revenue', period: 'LTM', required: true },
  ],
};
