import type { FatigueEvaluationInput, FatigueEvaluationResult, FatigueRuleFlag, FatigueRuleSet } from './fatigue-rule-set.interface';

/**
 * The four headline work/rest limits, parameterised so a customer can save
 * their own thresholds (a "savable layout" — see FatigueRuleSet in the DB and
 * the fatigue-rule-sets module) while the evaluation logic stays in one place.
 *
 * The AU defaults below are solo-driver "Standard Hours" under the Heavy
 * Vehicle National Law — the option most small courier operators run under.
 * See 08-Compliance/Australian_Compliance.md and NHVR_Compliance_Review.md for
 * what this v1 simplifies (two-up crewing, breach-severity tiers, sub-24h rest
 * cadence, BFM/AFM). A customer overriding these takes responsibility for the
 * numbers matching their own accreditation.
 */
export interface FatigueThresholds {
  name: string;
  jurisdiction: string;
  maxWork24hMin: number;
  minRest24hMin: number;
  maxWork7dMin: number;
  minRest7dMin: number;
  approachingBufferMin: number;
  /** How far back the caller must fetch shifts (defaults to the 7-day window + 1). */
  lookbackDays: number;
}

export const AU_STANDARD_HOURS_DEFAULTS: FatigueThresholds = {
  name: 'AU Standard Hours (solo driver, v1 simplification)',
  jurisdiction: 'AU',
  maxWork24hMin: 12 * 60,
  minRest24hMin: 7 * 60,
  maxWork7dMin: 72 * 60,
  minRest7dMin: 24 * 60,
  approachingBufferMin: 60,
  lookbackDays: 8,
};

function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function overlapMinutes(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): number {
  const start = Math.max(aStart.getTime(), bStart.getTime());
  const end = Math.min(aEnd.getTime(), bEnd.getTime());
  return end > start ? Math.round((end - start) / 60000) : 0;
}

function longestRestMinutes(shifts: FatigueEvaluationInput['shifts'], windowStart: Date, now: Date): number {
  const clipped = shifts
    .map((s) => ({ start: Math.max(s.startedAt.getTime(), windowStart.getTime()), end: Math.min(s.endedAt.getTime(), now.getTime()) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const seg of clipped) {
    const last = merged[merged.length - 1];
    if (last && seg.start <= last.end) last.end = Math.max(last.end, seg.end);
    else merged.push({ ...seg });
  }

  let longestGapMs = 0;
  let cursor = windowStart.getTime();
  for (const seg of merged) {
    longestGapMs = Math.max(longestGapMs, seg.start - cursor);
    cursor = seg.end;
  }
  longestGapMs = Math.max(longestGapMs, now.getTime() - cursor);
  return Math.round(longestGapMs / 60000);
}

/**
 * Build a FatigueRuleSet from a set of thresholds. This is what both the
 * built-in jurisdiction default and any customer-saved rule set flow through —
 * the arithmetic below never hard-codes a limit.
 */
export function createStandardHoursRuleSet(t: FatigueThresholds): FatigueRuleSet {
  function evaluate({ shifts, now }: FatigueEvaluationInput): FatigueEvaluationResult {
    const win24Start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const win7dStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    let workMinutesLast24h = 0;
    let workMinutesLast7d = 0;
    for (const shift of shifts) {
      workMinutesLast24h += overlapMinutes(shift.startedAt, shift.endedAt, win24Start, now);
      workMinutesLast7d += overlapMinutes(shift.startedAt, shift.endedAt, win7dStart, now);
    }
    const longestRestMinutesLast24h = longestRestMinutes(shifts, win24Start, now);
    const longestRestMinutesLast7d = longestRestMinutes(shifts, win7dStart, now);

    const breaches: FatigueRuleFlag[] = [];
    const approaching: FatigueRuleFlag[] = [];

    if (workMinutesLast24h >= t.maxWork24hMin) {
      breaches.push({ rule: 'MAX_WORK_24H', label: 'Maximum work hours (24h)', message: `Worked ${formatHours(workMinutesLast24h)} in the last 24 hours — exceeds the ${formatHours(t.maxWork24hMin)} limit.` });
    } else if (workMinutesLast24h >= t.maxWork24hMin - t.approachingBufferMin) {
      approaching.push({ rule: 'MAX_WORK_24H', label: 'Maximum work hours (24h)', message: `Worked ${formatHours(workMinutesLast24h)} in the last 24 hours — approaching the ${formatHours(t.maxWork24hMin)} limit.` });
    }

    if (longestRestMinutesLast24h < t.minRest24hMin) {
      breaches.push({ rule: 'MIN_REST_24H', label: 'Minimum continuous rest (24h)', message: `Longest continuous rest in the last 24 hours is ${formatHours(longestRestMinutesLast24h)} — below the ${formatHours(t.minRest24hMin)} minimum.` });
    } else if (longestRestMinutesLast24h < t.minRest24hMin + t.approachingBufferMin) {
      approaching.push({ rule: 'MIN_REST_24H', label: 'Minimum continuous rest (24h)', message: `Longest continuous rest in the last 24 hours is ${formatHours(longestRestMinutesLast24h)} — close to the ${formatHours(t.minRest24hMin)} minimum.` });
    }

    if (workMinutesLast7d >= t.maxWork7dMin) {
      breaches.push({ rule: 'MAX_WORK_7D', label: 'Maximum work hours (7 days)', message: `Worked ${formatHours(workMinutesLast7d)} in the last 7 days — exceeds the ${formatHours(t.maxWork7dMin)} limit.` });
    } else if (workMinutesLast7d >= t.maxWork7dMin - t.approachingBufferMin) {
      approaching.push({ rule: 'MAX_WORK_7D', label: 'Maximum work hours (7 days)', message: `Worked ${formatHours(workMinutesLast7d)} in the last 7 days — approaching the ${formatHours(t.maxWork7dMin)} limit.` });
    }

    if (longestRestMinutesLast7d < t.minRest7dMin) {
      breaches.push({ rule: 'MIN_REST_7D', label: 'Minimum continuous rest (7 days)', message: `Longest continuous rest in the last 7 days is ${formatHours(longestRestMinutesLast7d)} — below the ${formatHours(t.minRest7dMin)} minimum.` });
    } else if (longestRestMinutesLast7d < t.minRest7dMin + t.approachingBufferMin) {
      approaching.push({ rule: 'MIN_REST_7D', label: 'Minimum continuous rest (7 days)', message: `Longest continuous rest in the last 7 days is ${formatHours(longestRestMinutesLast7d)} — close to the ${formatHours(t.minRest7dMin)} minimum.` });
    }

    return {
      status: breaches.length > 0 ? 'breach' : approaching.length > 0 ? 'approaching_limit' : 'ok',
      breaches,
      approaching,
      workMinutesLast24h,
      longestRestMinutesLast24h,
      workMinutesLast7d,
      longestRestMinutesLast7d,
    };
  }

  return { jurisdiction: t.jurisdiction, name: t.name, lookbackDays: t.lookbackDays, evaluate };
}

/** The built-in AU default, used when a company has saved no custom rule set. */
export const AU_STANDARD_HOURS: FatigueRuleSet = createStandardHoursRuleSet(AU_STANDARD_HOURS_DEFAULTS);
