import { addBusinessDays, isWeekend, GRACE_PERIOD_BUSINESS_DAYS } from './business-days';

describe('business-days', () => {
  it('GRACE_PERIOD_BUSINESS_DAYS is 5', () => {
    expect(GRACE_PERIOD_BUSINESS_DAYS).toBe(5);
  });

  describe('isWeekend', () => {
    it('is true for Saturday and Sunday, false for weekdays', () => {
      expect(isWeekend(new Date('2026-01-03T00:00:00Z'))).toBe(true); // Sat
      expect(isWeekend(new Date('2026-01-04T00:00:00Z'))).toBe(true); // Sun
      expect(isWeekend(new Date('2026-01-02T00:00:00Z'))).toBe(false); // Fri
      expect(isWeekend(new Date('2026-01-05T00:00:00Z'))).toBe(false); // Mon
    });
  });

  describe('addBusinessDays', () => {
    it('5 business days from a Thursday spans the weekend and lands 7 CALENDAR days later (next Thursday), not 5', () => {
      const thu = new Date('2026-01-01T09:30:00Z');
      expect(thu.getUTCDay()).toBe(4); // self-check: Thursday
      const result = addBusinessDays(thu, 5);
      // Fri, Mon, Tue, Wed, Thu = five weekdays => Thursday 2026-01-08.
      // A naive +5 CALENDAR days would give 2026-01-06 (a Tuesday) — proving this
      // is real business-day math, not calendar math.
      expect(result.toISOString().slice(0, 10)).toBe('2026-01-08');
      expect(result.getUTCDay()).toBe(4);
    });

    it('advances Friday +1 business day to the following Monday (skips the weekend)', () => {
      const fri = new Date('2026-01-02T12:00:00Z');
      expect(fri.getUTCDay()).toBe(5);
      expect(addBusinessDays(fri, 1).toISOString().slice(0, 10)).toBe('2026-01-05'); // Mon
    });

    it('from a Saturday, +1 business day is the following Monday', () => {
      const sat = new Date('2026-01-03T08:00:00Z');
      expect(sat.getUTCDay()).toBe(6);
      expect(addBusinessDays(sat, 1).toISOString().slice(0, 10)).toBe('2026-01-05'); // Mon
    });

    it('returns an unchanged copy for 0 (and negative) business days', () => {
      const d = new Date('2026-01-01T09:30:00Z');
      expect(addBusinessDays(d, 0).toISOString()).toBe(d.toISOString());
      expect(addBusinessDays(d, -3).toISOString()).toBe(d.toISOString());
      // Copy, not the same reference.
      expect(addBusinessDays(d, 0)).not.toBe(d);
    });

    it('preserves the time-of-day of the start instant', () => {
      const start = new Date('2026-01-05T14:23:45.678Z'); // Monday
      const result = addBusinessDays(start, 5); // next Monday
      expect(result.toISOString()).toBe('2026-01-12T14:23:45.678Z');
    });
  });
});
