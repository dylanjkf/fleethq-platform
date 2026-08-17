import { SubscriptionStatus } from '@prisma/client';
import { isPastDueGraceElapsed } from './entitlements.service';

/**
 * Unit coverage for the non-payment grace gating (item 7): the account stays
 * writable through the whole 7-calendar-day window (weekends included) and only
 * becomes read-only once the window has genuinely elapsed.
 */
describe('isPastDueGraceElapsed', () => {
  const pastDue = { subscriptionStatus: SubscriptionStatus.PAST_DUE, paymentFailureCount: 1 };
  const failedAt = new Date('2026-01-01T09:00:00Z'); // Thursday
  // 7 calendar days (the real logic in billing.service.ts) -> 2026-01-08T09:00Z,
  // a window that spans a weekend, proving weekend days don't end grace early.
  const graceEnd = new Date(failedAt.getTime() + 7 * 24 * 60 * 60 * 1000);

  it('stays FALSE (account active) through the whole window, including the weekend it spans', () => {
    // A Saturday that falls inside the window — still active, proving weekend days
    // do not end the grace early.
    expect(isPastDueGraceElapsed({ ...pastDue, gracePeriodEndsAt: graceEnd }, new Date('2026-01-03T12:00:00Z'))).toBe(false);
    // The instant just before the deadline.
    expect(isPastDueGraceElapsed({ ...pastDue, gracePeriodEndsAt: graceEnd }, new Date(graceEnd.getTime() - 1))).toBe(false);
    // Exactly at the deadline is not yet elapsed (strict >).
    expect(isPastDueGraceElapsed({ ...pastDue, gracePeriodEndsAt: graceEnd }, graceEnd)).toBe(false);
  });

  it('becomes TRUE (restricted) only once the window has elapsed', () => {
    expect(isPastDueGraceElapsed({ ...pastDue, gracePeriodEndsAt: graceEnd }, new Date(graceEnd.getTime() + 1))).toBe(true);
    expect(isPastDueGraceElapsed({ ...pastDue, gracePeriodEndsAt: graceEnd }, new Date('2026-02-01T00:00:00Z'))).toBe(true);
  });

  it('is FALSE when no grace window has been set', () => {
    expect(isPastDueGraceElapsed({ ...pastDue, gracePeriodEndsAt: null }, new Date('2026-02-01T00:00:00Z'))).toBe(false);
  });

  it('is FALSE for a non-past-due company, or one with no recorded failures', () => {
    expect(
      isPastDueGraceElapsed({ subscriptionStatus: SubscriptionStatus.ACTIVE, paymentFailureCount: 1, gracePeriodEndsAt: graceEnd }, new Date(graceEnd.getTime() + 1)),
    ).toBe(false);
    expect(
      isPastDueGraceElapsed({ subscriptionStatus: SubscriptionStatus.PAST_DUE, paymentFailureCount: 0, gracePeriodEndsAt: graceEnd }, new Date(graceEnd.getTime() + 1)),
    ).toBe(false);
  });
});
