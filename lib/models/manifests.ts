/**
 * Each model declares the financial facts it requires. Pre-flight reads the
 * manifest, checks the cache, and fails fast (or triggers ingestion) when a
 * required fact is missing — so models never run on default placeholders.
 */

import type { FactMetric } from '@/lib/data/financial_facts';

export type ModelType = 'lbo' | 'ipo_valuation' | 'bond_pricing' | 'dcf';

export interface ManifestEntry {
  metric: FactMetric;
  /** 'LTM' or 'FY*' — null = any latest non-null. */
  period?: 'LTM' | 'annual_latest' | 'annual_history_3' | 'annual_history_5';
  description: string;
}

export interface ModelDataManifest {
  modelType: ModelType;
  required: ManifestEntry[];
  optional: ManifestEntry[];
}

export const LBO_MANIFEST: ModelDataManifest = {
  modelType: 'lbo',
  required: [
    { metric: 'revenue',          period: 'annual_latest', description: 'Most recent annual revenue' },
    { metric: 'ebitda',           period: 'annual_latest', description: 'Most recent annual EBITDA (operating income proxy when D&A not broken out)' },
  ],
  optional: [
    { metric: 'capex',            period: 'annual_latest', description: 'Capex (default: 5% of revenue if missing)' },
    { metric: 'long_term_debt',   period: 'annual_latest', description: 'Existing long-term debt (default: 0 if missing)' },
    { metric: 'operating_income', period: 'annual_history_3', description: 'Margin trend over recent years' },
  ],
};

export const IPO_MANIFEST: ModelDataManifest = {
  modelType: 'ipo_valuation',
  required: [
    { metric: 'revenue', period: 'annual_history_3', description: 'Last 3 annual revenue figures (for growth)' },
  ],
  optional: [
    { metric: 'gross_profit',      period: 'annual_history_3', description: 'Gross margin trend' },
    { metric: 'operating_income',  period: 'annual_history_3', description: 'Operating margin trend' },
    { metric: 'shares_outstanding', period: 'annual_latest',   description: 'Pre-IPO shares for implied $/sh' },
  ],
};

export const BOND_MANIFEST: ModelDataManifest = {
  modelType: 'bond_pricing',
  required: [
    { metric: 'revenue',           period: 'annual_latest',  description: 'Latest annual revenue (issuer scale)' },
    { metric: 'operating_income',  period: 'annual_latest',  description: 'Latest operating income for coverage' },
  ],
  optional: [
    { metric: 'long_term_debt',    period: 'annual_latest',  description: 'Existing debt for leverage' },
    { metric: 'cash_and_equivalents', period: 'annual_latest', description: 'Cash position for coverage' },
  ],
};

export const DCF_MANIFEST: ModelDataManifest = {
  modelType: 'dcf',
  required: [
    { metric: 'revenue',          period: 'annual_history_5', description: 'Five-year revenue history' },
    { metric: 'operating_income', period: 'annual_history_5', description: 'Five-year operating margin trend' },
  ],
  optional: [
    { metric: 'capex',            period: 'annual_history_5', description: 'Five-year capex' },
  ],
};

export function manifestFor(modelType: ModelType): ModelDataManifest {
  if (modelType === 'lbo') return LBO_MANIFEST;
  if (modelType === 'ipo_valuation') return IPO_MANIFEST;
  if (modelType === 'bond_pricing') return BOND_MANIFEST;
  return DCF_MANIFEST;
}
