/**
 * Business-day arithmetic for the non-payment grace window (item 7).
 *
 * "5 business days" is genuine weekday counting, NOT calendar days: a failure on
 * a Thursday grants grace through the following Thursday (Fri, Mon, Tue, Wed, Thu
 * = five weekdays), spanning the weekend — not the following Tuesday a naive
 * `+5 calendar days` would give.
 *
 * PUBLIC HOLIDAYS ARE NOT CONSIDERED — only Saturdays and Sundays are skipped.
 * This is a deliberate first-pass product decision: FleetOS serves multiple AU
 * states (and could serve other jurisdictions), whose public-holiday calendars
 * differ, so a correct holiday-aware grace window would need a per-jurisdiction
 * holiday source we don't have wired in. Weekends-only is predictable, jurisdiction
 * -independent, and errs slightly in the customer's favour (grace is never shorter
 * than the weekday count). Revisit if a holiday calendar is introduced.
 *
 * All arithmetic is in UTC so the result doesn't drift with server timezone; the
 * time-of-day of `from` is preserved (the window ends at the same wall-clock time
 * N business days later).
 */

/** Standard non-payment grace: five business days after the first failed charge. */
export const GRACE_PERIOD_BUSINESS_DAYS = 5;

/** True for Saturday (6) and Sunday (0) in UTC. */
export function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Returns a new Date `businessDays` weekdays after `from`, skipping weekends.
 * `businessDays` of 0 returns a copy of `from` unchanged. Negative inputs are
 * treated as 0 (there is no "business days ago" use here).
 */
export function addBusinessDays(from: Date, businessDays: number): Date {
  const result = new Date(from.getTime());
  let remaining = Math.max(0, Math.floor(businessDays));
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (!isWeekend(result)) remaining -= 1;
  }
  return result;
}
