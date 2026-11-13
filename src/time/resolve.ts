import { DateTime } from 'luxon';

/**
 * Deterministic resolution of relative time expressions ("last Tuesday",
 * "on 3 November", "Monday", "2 days ago") into concrete date ranges in the
 * user's timezone.
 *
 * Why code and not the LLM: date arithmetic is exactly where models are
 * unreliable, and a wrong date silently retrieves the wrong conversation.
 * This is small, fully unit-tested, and the LLM only ever sees the result.
 *
 * Bias: phrases are resolved into the PAST. People ask an agent about what
 * already happened ("on Monday we shortlisted…"), not about future Mondays.
 */

export interface TimeRange {
  /** ISO timestamp, inclusive. */
  start: string;
  /** ISO timestamp, exclusive. */
  end: string;
}

export interface ResolvedRange {
  label: string;
  range: TimeRange;
}

export interface TimeRef extends ResolvedRange {
  /** The text that matched, e.g. "last Tuesday". */
  phrase: string;
  /** Other plausible readings, tried only if the primary range has no memory.
   *  e.g. "last Tuesday" said on a Thursday: 2 days ago, or the week before. */
  alternates: ResolvedRange[];
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const WORD_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, 'couple of': 2,
};

function monthNum(token: string): number {
  return MONTHS[token.slice(0, 3).toLowerCase()] ?? 0;
}

function toNum(token: string): number | undefined {
  const t = token.toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return WORD_NUM[t];
}

function day(dt: DateTime): ResolvedRange {
  const start = dt.startOf('day');
  return {
    label: start.toFormat('cccc d LLLL yyyy'),
    range: { start: start.toISO()!, end: start.plus({ days: 1 }).toISO()! },
  };
}

function span(start: DateTime, endExclusive: DateTime, label: string): ResolvedRange {
  return { label, range: { start: start.toISO()!, end: endExclusive.toISO()! } };
}

/** A date with no year means the most recent past occurrence. */
function pastDate(today: DateTime, month: number, dayOfMonth: number, year?: number): DateTime | null {
  let dt = DateTime.fromObject({ year: year ?? today.year, month, day: dayOfMonth }, { zone: today.zone });
  if (!dt.isValid) return null;
  if (!year && dt > today.endOf('day')) dt = dt.minus({ years: 1 });
  return dt;
}

interface Rule {
  re: RegExp;
  resolve: (m: RegExpExecArray, today: DateTime) => Omit<TimeRef, 'phrase'> | null;
}

const RULES: Rule[] = [
  // 2026-11-03
  {
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/gi,
    resolve: (m, today) => {
      const dt = DateTime.fromObject(
        { year: +m[1]!, month: +m[2]!, day: +m[3]! },
        { zone: today.zone },
      );
      return dt.isValid ? { ...day(dt), alternates: [] } : null;
    },
  },
  // 3 November, 3rd of Nov, 3 Nov 2026
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_RE})\\b(?:,?\\s+(\\d{4}))?`, 'gi'),
    resolve: (m, today) => {
      const dt = pastDate(today, monthNum(m[2]!), +m[1]!, m[3] ? +m[3] : undefined);
      return dt ? { ...day(dt), alternates: [] } : null;
    },
  },
  // November 3, Nov 3rd, 2026
  {
    re: new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'gi'),
    resolve: (m, today) => {
      const dt = pastDate(today, monthNum(m[1]!), +m[2]!, m[3] ? +m[3] : undefined);
      return dt ? { ...day(dt), alternates: [] } : null;
    },
  },
  // in October / back in March 2026
  {
    re: new RegExp(`\\b(?:in|during|back in|since)\\s+(${MONTH_RE})\\b(?:\\s+(\\d{4}))?`, 'gi'),
    resolve: (m, today) => {
      const first = pastDate(today, monthNum(m[1]!), 1, m[2] ? +m[2] : undefined);
      if (!first) return null;
      return { ...span(first, first.plus({ months: 1 }), first.toFormat('LLLL yyyy')), alternates: [] };
    },
  },
  {
    re: /\b(?:the\s+)?day\s+before\s+yesterday\b/gi,
    resolve: (_m, today) => ({ ...day(today.minus({ days: 2 })), alternates: [] }),
  },
  {
    re: /\byesterday\b/gi,
    resolve: (_m, today) => ({ ...day(today.minus({ days: 1 })), alternates: [] }),
  },
  {
    re: /\b(?:earlier\s+today|today|this\s+(?:morning|afternoon|evening)|tonight)\b/gi,
    resolve: (_m, today) => ({ ...day(today), alternates: [] }),
  },
  // 3 days ago / a couple of days ago
  {
    re: /\b(\d+|a|one|two|three|four|five|six|seven|couple of)\s+days?\s+ago\b/gi,
    resolve: (m, today) => {
      const n = toNum(m[1]!);
      if (n === undefined) return null;
      const d = today.minus({ days: n });
      return { ...day(d), alternates: [day(d.minus({ days: 1 })), day(d.plus({ days: 1 }))] };
    },
  },
  {
    re: /\b(?:a\s+)?few\s+days\s+ago\b/gi,
    resolve: (_m, today) => ({
      ...span(today.minus({ days: 5 }).startOf('day'), today.minus({ days: 1 }).startOf('day'), 'a few days ago'),
      alternates: [],
    }),
  },
  // 2 weeks ago -> a window around that day
  {
    re: /\b(\d+|a|one|two|three|four)\s+weeks?\s+ago\b/gi,
    resolve: (m, today) => {
      const n = toNum(m[1]!);
      if (n === undefined) return null;
      const centre = today.minus({ weeks: n }).startOf('day');
      return {
        ...span(centre.minus({ days: 3 }), centre.plus({ days: 4 }), `around ${centre.toFormat('d LLLL yyyy')}`),
        alternates: [],
      };
    },
  },
  // last week / this week / past week / last month / this month
  {
    re: /\b(last|this|past|previous)\s+(week|month)\b/gi,
    resolve: (m, today) => {
      const which = m[1]!.toLowerCase();
      const unit = m[2]!.toLowerCase() as 'week' | 'month';
      if (which === 'past') {
        const start = today.minus(unit === 'week' ? { days: 7 } : { days: 30 }).startOf('day');
        return { ...span(start, today.plus({ days: 1 }).startOf('day'), `the past ${unit}`), alternates: [] };
      }
      const thisStart = today.startOf(unit);
      if (which === 'this') {
        return { ...span(thisStart, today.plus({ days: 1 }).startOf('day'), `this ${unit}`), alternates: [] };
      }
      const prevStart = thisStart.minus(unit === 'week' ? { weeks: 1 } : { months: 1 });
      const label =
        unit === 'week'
          ? `last week (${prevStart.toFormat('d LLL')}–${thisStart.minus({ days: 1 }).toFormat('d LLL yyyy')})`
          : prevStart.toFormat('LLLL yyyy');
      return { ...span(prevStart, thisStart, label), alternates: [] };
    },
  },
  // (last|this|on) Monday. "(?!\.com)" so the CRM "monday.com" is not a date.
  {
    re: /\b(?:(last|this|past|previous|on)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?!\.com|\s+\.com)/gi,
    resolve: (m, today) => {
      const qualifier = m[1]?.toLowerCase();
      const target = WEEKDAYS.indexOf(m[2]!.toLowerCase()) + 1; // luxon: Mon=1
      let diff = (today.weekday - target + 7) % 7;
      const sameDay = diff === 0;
      if (sameDay) diff = 7;
      const primary = today.minus({ days: diff });
      const alternates: ResolvedRange[] = [];
      // "last Tuesday" can also mean "Tuesday of last week".
      if ((qualifier === 'last' || qualifier === 'previous') && diff < 7) {
        alternates.push(day(primary.minus({ days: 7 })));
      }
      // "on Monday", said on a Monday, may mean today.
      if (sameDay && qualifier !== 'last' && qualifier !== 'previous') alternates.push(day(today));
      return { ...day(primary), alternates };
    },
  },
];

export function resolveTimeRefs(text: string, now: Date, timezone: string): TimeRef[] {
  const today = DateTime.fromJSDate(now, { zone: timezone });
  const taken: Array<[number, number]> = [];
  const refs: TimeRef[] = [];

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      const from = m.index;
      const to = from + m[0].length;
      if (taken.some(([a, b]) => from < b && to > a)) continue; // earlier, more specific rule won
      const resolved = rule.resolve(m, today);
      if (!resolved) continue;
      taken.push([from, to]);
      if (refs.some((r) => r.range.start === resolved.range.start && r.range.end === resolved.range.end)) continue;
      refs.push({ phrase: m[0], ...resolved });
    }
  }
  return refs.sort((a, b) => text.indexOf(a.phrase) - text.indexOf(b.phrase));
}

/** Human-readable "now" for prompts, in the user's timezone. */
export function describeNow(now: Date, timezone: string): string {
  return DateTime.fromJSDate(now, { zone: timezone }).toFormat("cccc d LLLL yyyy, HH:mm '('z')'");
}

export function formatLocal(iso: string, timezone: string, fmt = 'ccc d LLL yyyy, HH:mm'): string {
  return DateTime.fromISO(iso, { zone: timezone }).toFormat(fmt);
}

export function inRange(iso: string, range: TimeRange): boolean {
  const t = Date.parse(iso);
  return t >= Date.parse(range.start) && t < Date.parse(range.end);
}
