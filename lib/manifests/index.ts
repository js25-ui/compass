/**
 * Registry: maps every TaskType to its manifest. The clarification engine
 * loads from here after task classification.
 *
 * Manifests not yet fully populated fall through to a generic placeholder
 * with required = entity, deliverable_format only. Adding the full parameter
 * set later is data entry — the infrastructure picks them up automatically.
 */

import type { TaskManifest, TaskType } from './types';
import { LBO_MANIFEST } from './lbo';
import { TRADING_COMPS_MANIFEST } from './trading_comps';
import { IPO_VALUATION_MANIFEST } from './ipo_valuation';
import { BOND_PRICING_MANIFEST } from './bond_pricing';
import { DCF_MANIFEST } from './dcf';
import { PRECEDENTS_MANIFEST } from './precedents';
import { IC_MEMO_MANIFEST } from './ic_memo';
import { PITCH_BOOK_MANIFEST } from './pitch_book';
import { FOOTBALL_FIELD_MANIFEST } from './football_field';
import { GENERIC_MANIFEST } from './generic';

const REGISTRY: Partial<Record<TaskType, TaskManifest>> = {
  lbo: LBO_MANIFEST,
  trading_comps: TRADING_COMPS_MANIFEST,
  ipo_valuation: IPO_VALUATION_MANIFEST,
  bond_pricing: BOND_PRICING_MANIFEST,
  dcf: DCF_MANIFEST,
  precedents: PRECEDENTS_MANIFEST,
  ic_memo: IC_MEMO_MANIFEST,
  pitch_book: PITCH_BOOK_MANIFEST,
  football_field: FOOTBALL_FIELD_MANIFEST,
};

export function manifestFor(taskType: TaskType): TaskManifest {
  return REGISTRY[taskType] ?? GENERIC_MANIFEST;
}

export function listManifests(): TaskManifest[] {
  return Object.values(REGISTRY).filter((m): m is TaskManifest => Boolean(m));
}

export type { TaskManifest, TaskType, ParamSpec, ParamKind, ValidationRule } from './types';
export { LBO_MANIFEST, TRADING_COMPS_MANIFEST };
