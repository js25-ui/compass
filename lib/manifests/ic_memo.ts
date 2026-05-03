import type { TaskManifest } from './types';

export const IC_MEMO_MANIFEST: TaskManifest = {
  taskType: 'ic_memo',
  label: 'IC Memo',
  description: 'Investment Committee memo: recommendation, exec summary, thesis, returns, risks, diligence — all corpus-cited.',
  required: [
    {
      id: 'recommendation_type',
      label: 'Recommendation',
      prompt: 'Direction of the recommendation?',
      kind: 'select',
      default: 'approve',
      options: [
        { value: 'approve', label: 'Approve / Buy' },
        { value: 'reject', label: 'Reject / Sell' },
        { value: 'hold', label: 'Hold / Monitor' },
        { value: 'conditional', label: 'Conditional approval' },
      ],
    },
    {
      id: 'memo_length',
      label: 'Memo length',
      prompt: 'How long?',
      kind: 'select',
      default: 'standard',
      options: [
        { value: 'short', label: 'Short (1-2 pages)' },
        { value: 'standard', label: 'Standard (3-5 pages)' },
        { value: 'detailed', label: 'Detailed (6-10 pages)' },
      ],
    },
  ],
  recommended: [
    {
      id: 'thesis_priority',
      label: 'Thesis priority',
      prompt: 'Which thesis dimension leads?',
      kind: 'select',
      default: 'growth',
      options: [
        { value: 'growth', label: 'Growth' },
        { value: 'margin', label: 'Margin' },
        { value: 'defensibility', label: 'Defensibility' },
        { value: 'capital_returns', label: 'Capital returns' },
      ],
    },
    {
      id: 'risk_emphasis',
      label: 'Risk emphasis',
      prompt: 'Which risks to emphasize?',
      kind: 'multi_select',
      default: ['financial', 'market'],
      options: [
        { value: 'financial', label: 'Financial' },
        { value: 'market', label: 'Market' },
        { value: 'regulatory', label: 'Regulatory' },
        { value: 'operational', label: 'Operational' },
        { value: 'ai_disruption', label: 'AI disruption' },
        { value: 'execution', label: 'Execution' },
      ],
    },
    {
      id: 'audience',
      label: 'Audience',
      prompt: 'Who is reading this?',
      kind: 'select',
      default: 'investment_committee',
      options: [
        { value: 'investment_committee', label: 'Investment Committee' },
        { value: 'senior_management', label: 'Senior Management' },
        { value: 'board', label: 'Board' },
        { value: 'client', label: 'Client' },
      ],
    },
  ],
  optional: [],
  validation: [],
  data: [],
};
