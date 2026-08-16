import { isWithinMinimumTerm } from './billing.service';

describe('isWithinMinimumTerm (12-month contract lock, Part 2)', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('is locked while the contract end is in the future and not released', () => {
    expect(isWithinMinimumTerm({ contractEndsAt: new Date('2026-12-01T00:00:00.000Z'), contractReleasedAt: null }, now)).toBe(true);
  });

  it('is not locked once the contract end has passed', () => {
    expect(isWithinMinimumTerm({ contractEndsAt: new Date('2026-05-31T23:59:59.000Z'), contractReleasedAt: null }, now)).toBe(false);
  });

  it('is not locked when there is no contract end (never subscribed)', () => {
    expect(isWithinMinimumTerm({ contractEndsAt: null, contractReleasedAt: null }, now)).toBe(false);
  });

  it('cancel_for_cause release lifts the lock even before the contract end', () => {
    expect(
      isWithinMinimumTerm(
        { contractEndsAt: new Date('2026-12-01T00:00:00.000Z'), contractReleasedAt: new Date('2026-05-20T00:00:00.000Z') },
        now,
      ),
    ).toBe(false);
  });
});
