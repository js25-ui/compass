/**
 * Input validation. Validators don't run models — they check that the user's
 * scope answers, combined with the gathered financial facts, are
 * mathematically and practically sane.
 *
 * Each validator returns:
 *  - errors  → block execution; user must revise
 *  - warnings → run anyway, but the renderer surfaces them
 *
 * Never silent. Never NaN. The pipeline routes errors back to the UI as a
 * 'validation_failed' event with explicit revise-and-retry options.
 */

export interface ValidationIssue {
  level: 'error' | 'warn';
  field?: string;        // scope answer key, e.g. 'leverage_multiple'
  message: string;       // human-friendly explanation
  suggestion?: string;   // recommended value(s) or next action
}

export function isFinitePositive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/* ------------ LBO ------------ */

export interface LBOValidatorInput {
  entryEV: number;
  initialRevenue: number;
  ebitdaMargin: number;     // decimal
  leverageMultiple: number;
  revenueCAGR: number;      // decimal
  exitMultiple: number;
  holdPeriod: number;
  costOfDebt: number;       // decimal
  capexPctRevenue: number;  // decimal
}

export function validateLBO(input: LBOValidatorInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!isFinitePositive(input.entryEV)) {
    issues.push({
      level: 'error',
      field: 'entry_ev',
      message: 'Entry EV is required and must be a positive number.',
      suggestion: 'Open the scope card and enter the entry enterprise value in $M (e.g. 1200 for $1.2B).',
    });
  }
  if (!isFinitePositive(input.initialRevenue)) {
    issues.push({ level: 'error', field: 'revenue', message: 'Base-year revenue is missing or zero.', suggestion: 'Compass needs a real revenue figure to run an LBO. Try a public-company target.' });
  }
  if (!isFinitePositive(input.ebitdaMargin)) {
    issues.push({ level: 'error', field: 'ebitda_margin', message: 'EBITDA margin must be a positive decimal.', suggestion: 'Use 0.10–0.55 typical range.' });
  } else if (input.ebitdaMargin > 0.7) {
    issues.push({ level: 'warn', field: 'ebitda_margin', message: `EBITDA margin ${(input.ebitdaMargin * 100).toFixed(1)}% is exceptionally high.`, suggestion: 'Verify the margin source — software / royalty businesses can run 50-65% but >70% is rare.' });
  }

  // Entry multiple sanity.
  if (isFinitePositive(input.entryEV) && isFinitePositive(input.initialRevenue) && isFinitePositive(input.ebitdaMargin)) {
    const entryEBITDA = input.initialRevenue * input.ebitdaMargin;
    const entryMultiple = entryEBITDA > 0 ? input.entryEV / entryEBITDA : Infinity;
    if (entryMultiple > 30) {
      issues.push({
        level: 'error',
        field: 'entry_ev',
        message: `Entry EV ($${(input.entryEV / 1000).toFixed(1)}B) implies ${entryMultiple.toFixed(0)}x base-year EBITDA — well above any normal LBO range (5-25x).`,
        suggestion: `Either reduce entry EV to roughly $${(entryEBITDA * 12).toFixed(0)}M (≈12x EBITDA) or revise the base-year revenue / margin upward if you believe the company is already further along than the latest filing shows.`,
      });
    } else if (entryMultiple < 5) {
      issues.push({
        level: 'warn',
        field: 'entry_ev',
        message: `Entry EV implies only ${entryMultiple.toFixed(1)}x base-year EBITDA. That's a steep discount to typical LBO entry multiples (8-15x).`,
        suggestion: 'Confirm the entry EV — distressed / value plays can land here but it is unusual.',
      });
    }
  }

  if (input.leverageMultiple < 0) {
    issues.push({ level: 'error', field: 'leverage_multiple', message: 'Leverage cannot be negative.' });
  } else if (input.leverageMultiple > 9) {
    issues.push({ level: 'warn', field: 'leverage_multiple', message: `Leverage ${input.leverageMultiple.toFixed(1)}x is above sponsor norms (typically 4-7x).`, suggestion: 'High leverage works only with very stable cash flows.' });
  } else if (input.leverageMultiple < 2 && input.leverageMultiple > 0) {
    issues.push({ level: 'warn', field: 'leverage_multiple', message: `Leverage ${input.leverageMultiple.toFixed(1)}x is below sponsor norms — the deal looks more like a strategic / cash buyer setup than a sponsor LBO.` });
  }

  if (input.revenueCAGR < -0.5) {
    issues.push({ level: 'error', field: 'revenue_cagr', message: `Revenue CAGR of ${(input.revenueCAGR * 100).toFixed(0)}% would more than halve revenue every year — implausible.` });
  } else if (input.revenueCAGR > 1.0) {
    issues.push({ level: 'warn', field: 'revenue_cagr', message: `Revenue CAGR ${(input.revenueCAGR * 100).toFixed(0)}% sustained over ${input.holdPeriod}Y is aggressive.`, suggestion: 'Consider stepping down growth in later years or stress-test the case at lower CAGRs.' });
  }

  if (!isFinitePositive(input.exitMultiple)) {
    issues.push({ level: 'error', field: 'exit_multiple', message: 'Exit multiple must be positive.' });
  } else if (input.exitMultiple > 35) {
    issues.push({ level: 'warn', field: 'exit_multiple', message: `Exit multiple ${input.exitMultiple.toFixed(1)}x is aggressive — peak hyper-growth software prints here.` });
  }

  if (input.holdPeriod < 1 || input.holdPeriod > 12) {
    issues.push({ level: 'error', field: 'hold_period', message: 'Hold period must be between 1 and 12 years.' });
  }

  if (input.costOfDebt < 0 || input.costOfDebt > 0.25) {
    issues.push({ level: 'warn', field: 'cost_of_debt', message: `Cost of debt ${(input.costOfDebt * 100).toFixed(1)}% is outside the 4-15% typical range.` });
  }

  if (input.capexPctRevenue < 0 || input.capexPctRevenue > 0.4) {
    issues.push({ level: 'warn', field: 'capex_pct_revenue', message: `Capex / revenue ${(input.capexPctRevenue * 100).toFixed(1)}% is outside typical (1-25%).` });
  }

  return issues;
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some(i => i.level === 'error');
}
