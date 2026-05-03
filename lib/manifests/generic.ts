import type { TaskManifest } from './types';

/**
 * Fallback manifest used when a task type is recognized but doesn't yet have
 * a fully-populated entry. Asks only for the deliverable format so the
 * orchestrator can route somewhere useful.
 */
export const GENERIC_MANIFEST: TaskManifest = {
  taskType: 'chat_answer',
  label: 'Open-ended question',
  description: 'No specific deliverable type identified — Compass will answer in chat with cited sources.',
  required: [],
  recommended: [],
  optional: [],
  validation: [],
  data: [],
};
