/**
 * Numeric output sanity gate.
 *
 * Scans a rendered HTML token for known numeric-leak markers — NaN,
 * Infinity, undefined, null — that would indicate a model bug
 * substituted a placeholder for a real value somewhere in the pipeline.
 * Returns the list of leaks (with brief context) so the route can emit
 * a warning event and the user is told explicitly rather than seeing a
 * garbage cell in a table.
 */

const LEAK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bNaN\b/g, reason: 'NaN — division-by-zero or missing input not guarded' },
  { pattern: /\bInfinity\b/gi, reason: 'Infinity — denominator went to zero' },
  { pattern: />undefined</g, reason: 'undefined — a value was never set' },
  { pattern: /\$undefined\b/gi, reason: 'undefined money value' },
  { pattern: />null</g, reason: 'null — value was never populated' },
  { pattern: /\[object Object\]/g, reason: 'object-as-string — toString never called' },
];

export interface NumericLeak {
  reason: string;
  context: string;     // ~60 chars around the leak
}

export function scanNumericLeaks(html: string): NumericLeak[] {
  const leaks: NumericLeak[] = [];
  for (const { pattern, reason } of LEAK_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(html)) !== null) {
      const start = Math.max(0, m.index - 30);
      const end = Math.min(html.length, m.index + m[0].length + 30);
      leaks.push({
        reason,
        context: html.slice(start, end).replace(/\s+/g, ' '),
      });
      if (!pattern.global) break;
    }
  }
  return leaks;
}
