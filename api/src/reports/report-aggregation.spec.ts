import { mergeDowntimeMsByAsset, FaultWindow } from './report-aggregation';

const HOUR = 60 * 60 * 1000;
const from = new Date('2026-01-01T00:00:00.000Z');
const to = new Date('2026-01-02T00:00:00.000Z'); // a 24h window
const at = (hoursIntoWindow: number) => new Date(from.getTime() + hoursIntoWindow * HOUR);

describe('mergeDowntimeMsByAsset', () => {
  it('measures a single closed window clipped to the range', () => {
    const rows: FaultWindow[] = [{ assetId: 'a', createdAt: at(2), completedAt: at(5) }];
    expect(mergeDowntimeMsByAsset(rows, from, to).get('a')).toBe(3 * HOUR);
  });

  it('treats a still-open fault as down through the window end', () => {
    const rows: FaultWindow[] = [{ assetId: 'a', createdAt: at(20), completedAt: null }];
    expect(mergeDowntimeMsByAsset(rows, from, to).get('a')).toBe(4 * HOUR);
  });

  it('merges overlapping windows on one asset instead of double-counting', () => {
    const rows: FaultWindow[] = [
      { assetId: 'a', createdAt: at(1), completedAt: at(6) },
      { assetId: 'a', createdAt: at(4), completedAt: at(8) }, // overlaps the first
    ];
    expect(mergeDowntimeMsByAsset(rows, from, to).get('a')).toBe(7 * HOUR); // [1,8], not 5+4
  });

  it('sums disjoint windows on one asset', () => {
    const rows: FaultWindow[] = [
      { assetId: 'a', createdAt: at(1), completedAt: at(3) },
      { assetId: 'a', createdAt: at(10), completedAt: at(13) },
    ];
    expect(mergeDowntimeMsByAsset(rows, from, to).get('a')).toBe(5 * HOUR);
  });

  it('clips a window that starts before the range to the range start', () => {
    const rows: FaultWindow[] = [{ assetId: 'a', createdAt: new Date(from.getTime() - 10 * HOUR), completedAt: at(2) }];
    expect(mergeDowntimeMsByAsset(rows, from, to).get('a')).toBe(2 * HOUR);
  });

  it('ignores a window that closed before the range (no overlap)', () => {
    const rows: FaultWindow[] = [
      { assetId: 'a', createdAt: new Date(from.getTime() - 10 * HOUR), completedAt: new Date(from.getTime() - 5 * HOUR) },
    ];
    expect(mergeDowntimeMsByAsset(rows, from, to).has('a')).toBe(false);
  });

  it('keeps each asset separate', () => {
    const rows: FaultWindow[] = [
      { assetId: 'a', createdAt: at(0), completedAt: at(6) },
      { assetId: 'b', createdAt: at(0), completedAt: at(2) },
    ];
    const result = mergeDowntimeMsByAsset(rows, from, to);
    expect(result.get('a')).toBe(6 * HOUR);
    expect(result.get('b')).toBe(2 * HOUR);
  });
});
