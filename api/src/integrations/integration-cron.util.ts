/**
 * Minimal, dependency-free 5-field cron support (minute hour dom month dow) —
 * no cron-parsing library, per this codebase's "no unnecessary deps"
 * convention. Covers `*`, lists (`1,2,3`), ranges (`1-5`), and steps (a
 * slash followed by a number, e.g. every-15 or a ranged step) for each
 * field. Day-of-month and day-of-week follow
 * standard cron semantics: if BOTH are restricted (not `*`), a candidate
 * matches if EITHER matches (OR, not AND); if only one is restricted, that
 * one alone must match.
 *
 * `computeNextCronRun` brute-forces minute-by-minute from `from` up to
 * `maxDays` out (default 366) — fine for infrequent scheduler-tick use, not
 * a hot path. Evaluated in the server process's local time (this deployment
 * runs in UTC); returns null if the expression is malformed or no match falls
 * within the search window (e.g. a Feb 29 schedule missed by one day).
 */

/** The non-`*` bound of a step expression's range part, e.g. "5-20" or "10" in "5-20/2" / "10/3". */
function parseStepRange(rangePart: string, max: number): { start: number; end: number } {
  if (rangePart.includes('-')) {
    const [s, e] = rangePart.split('-').map(Number);
    return { start: s, end: e };
  }
  return { start: parseInt(rangePart, 10), end: max };
}

function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const result = new Set<number>();
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^(\*|\d+-\d+|\d+)\/(\d+)$/);
    if (stepMatch) {
      const [, rangePart, stepStr] = stepMatch;
      const step = parseInt(stepStr, 10);
      if (!step || step < 1) return null;
      const { start, end } = rangePart === '*' ? { start: min, end: max } : parseStepRange(rangePart, max);
      for (let i = start; i <= end; i += step) result.add(i);
      continue;
    }
    if (part === '*') {
      for (let i = min; i <= max; i++) result.add(i);
      continue;
    }
    if (part.includes('-')) {
      const [s, e] = part.split('-').map(Number);
      if (Number.isNaN(s) || Number.isNaN(e)) return null;
      for (let i = s; i <= e; i++) result.add(i);
      continue;
    }
    const n = parseInt(part, 10);
    if (Number.isNaN(n)) return null;
    result.add(n);
  }
  return result.size > 0 ? result : null;
}

export function computeNextCronRun(cronExpr: string, from: Date, maxDays = 366): Date | null {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = fields;

  const minutes = parseCronField(minF, 0, 59);
  const hours = parseCronField(hourF, 0, 23);
  const doms = parseCronField(domF, 1, 31);
  const months = parseCronField(monF, 1, 12);
  const dows = parseCronField(dowF, 0, 6); // 0 = Sunday, matches Date#getDay()
  if (!minutes || !hours || !doms || !months || !dows) return null;

  const domRestricted = domF.trim() !== '*';
  const dowRestricted = dowF.trim() !== '*';

  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const limit = new Date(from.getTime() + maxDays * 24 * 60 * 60 * 1000);

  while (candidate <= limit) {
    const domMatch = doms.has(candidate.getDate());
    const dowMatch = dows.has(candidate.getDay());
    const dayMatches =
      domRestricted && dowRestricted ? domMatch || dowMatch : domRestricted ? domMatch : dowRestricted ? dowMatch : true;

    if (minutes.has(candidate.getMinutes()) && hours.has(candidate.getHours()) && months.has(candidate.getMonth() + 1) && dayMatches) {
      return new Date(candidate.getTime());
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}
