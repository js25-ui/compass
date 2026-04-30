/**
 * Deterministic natural-language → date range parser.
 * Returns null when the query has no temporal hint or the hint is ambiguous;
 * the caller can then fall back to an LLM extractor.
 */

export interface TimeRange {
  start: Date;
  end: Date;
  label: string;             // human-readable description
  source: 'year' | 'quarter' | 'range' | 'relative' | 'named_event';
}

interface NamedEvent {
  patterns: RegExp[];
  start: string;             // ISO date
  end: string;
  label: string;
}

const NAMED_EVENTS: NamedEvent[] = [
  {
    patterns: [/\b(2008|gfc|global financial|financial)\s*(crisis|meltdown|gfc)?\b/i, /\bsubprime\b/i, /\blehman\b/i],
    start: '2007-07-01', end: '2009-06-30', label: '2008 financial crisis',
  },
  {
    patterns: [/\b(covid|pandemic|coronavirus|covid-19)\b/i],
    start: '2020-02-01', end: '2021-12-31', label: 'COVID-19 pandemic',
  },
  {
    patterns: [/\b737\s*max\b/i, /\bboeing\s*max\b/i],
    start: '2018-10-01', end: '2020-12-31', label: '737 MAX grounding',
  },
  {
    patterns: [/\b(dotcom|dot-com|dot com)\s*(bust|crash|bubble)?\b/i],
    start: '2000-03-01', end: '2002-10-31', label: 'dot-com bust',
  },
  {
    patterns: [/\b(silicon valley bank|svb|march 2023 banking)\s*(collapse|crisis|run)?\b/i],
    start: '2023-03-01', end: '2023-06-30', label: 'SVB collapse',
  },
  {
    patterns: [/\b(taper tantrum)\b/i],
    start: '2013-05-01', end: '2013-09-30', label: 'taper tantrum',
  },
  {
    patterns: [/\b(fomc|fed)\s*(2022|2023)\s*(hike|tightening|cycle)?\b/i, /\b(rate hiking cycle|hiking cycle)\b/i],
    start: '2022-03-01', end: '2023-12-31', label: 'Fed rate hiking cycle',
  },
];

const QUARTER_RE = /\bQ([1-4])\s+(\d{4})\b/i;
const SINGLE_YEAR_RE = /\b(?:fy[- ]?)?(\d{4})\b/i;
const YEAR_RANGE_RE = /\b(\d{4})\s*[-–to]+\s*(\d{4})\b/i;
const RELATIVE_RE = /\blast\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)\b/i;

const QUARTER_BOUNDS: Record<string, [string, string]> = {
  '1': ['01-01', '03-31'],
  '2': ['04-01', '06-30'],
  '3': ['07-01', '09-30'],
  '4': ['10-01', '12-31'],
};

export function parseTimeRange(query: string): TimeRange | null {
  for (const event of NAMED_EVENTS) {
    if (event.patterns.some(p => p.test(query))) {
      return { start: new Date(event.start), end: new Date(event.end), label: event.label, source: 'named_event' };
    }
  }

  const yearRange = query.match(YEAR_RANGE_RE);
  if (yearRange) {
    const [, a, b] = yearRange;
    return {
      start: new Date(`${a}-01-01`),
      end: new Date(`${b}-12-31`),
      label: `${a}-${b}`,
      source: 'range',
    };
  }

  const quarter = query.match(QUARTER_RE);
  if (quarter) {
    const [, q, year] = quarter;
    const [s, e] = QUARTER_BOUNDS[q];
    return {
      start: new Date(`${year}-${s}`),
      end: new Date(`${year}-${e}`),
      label: `Q${q} ${year}`,
      source: 'quarter',
    };
  }

  const relative = query.match(RELATIVE_RE);
  if (relative) {
    const [, nStr, unit] = relative;
    const n = parseInt(nStr, 10);
    const end = new Date();
    const start = new Date();
    if (/day/i.test(unit)) start.setDate(start.getDate() - n);
    else if (/week/i.test(unit)) start.setDate(start.getDate() - n * 7);
    else if (/month/i.test(unit)) start.setMonth(start.getMonth() - n);
    else start.setFullYear(start.getFullYear() - n);
    return { start, end, label: `last ${n} ${unit}`, source: 'relative' };
  }

  const singleYear = query.match(SINGLE_YEAR_RE);
  if (singleYear) {
    const year = singleYear[1];
    const yearNum = parseInt(year, 10);
    const currentYear = new Date().getFullYear();
    if (yearNum >= 1990 && yearNum <= currentYear + 1) {
      return {
        start: new Date(`${year}-01-01`),
        end: new Date(`${year}-12-31`),
        label: `FY${year}`,
        source: 'year',
      };
    }
  }

  return null;
}

export function isWithin(range: TimeRange, isoDate: string): boolean {
  const d = new Date(isoDate);
  return d >= range.start && d <= range.end;
}
