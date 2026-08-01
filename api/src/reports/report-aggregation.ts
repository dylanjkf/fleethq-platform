/** One open-fault window as the uptime reducer reads it: the asset, when the
 *  fault opened, and when it closed (null = still open). */
export interface FaultWindow {
  assetId: string;
  createdAt: Date;
  completedAt: Date | null;
}

/**
 * Merge each asset's open-fault windows — clipped to [from, to] — into total
 * downtime milliseconds per asset. A maintenance job takes its asset out of
 * service while it is open; a still-open job (completedAt null) counts as down
 * through `to`. Overlapping windows on the same asset are merged, so two
 * simultaneous faults don't double-count the downtime, and a window that
 * doesn't overlap the range contributes nothing. Pure — extracted from
 * ReportsService.operations so the interval-merge can be unit tested without a
 * Nest app or a database.
 */
export function mergeDowntimeMsByAsset(rows: FaultWindow[], from: Date, to: Date): Map<string, number> {
  const intervalsByAsset = new Map<string, { start: number; end: number }[]>();
  for (const job of rows) {
    const start = Math.max(job.createdAt.getTime(), from.getTime());
    const end = Math.min((job.completedAt ?? to).getTime(), to.getTime());
    if (end <= start) continue;
    const arr = intervalsByAsset.get(job.assetId) ?? [];
    arr.push({ start, end });
    intervalsByAsset.set(job.assetId, arr);
  }
  const downtimeMsByAsset = new Map<string, number>();
  for (const [assetId, intervals] of intervalsByAsset) {
    intervals.sort((a, b) => a.start - b.start);
    let mergedMs = 0;
    let curStart = intervals[0].start;
    let curEnd = intervals[0].end;
    for (let i = 1; i < intervals.length; i++) {
      const iv = intervals[i];
      if (iv.start <= curEnd) {
        curEnd = Math.max(curEnd, iv.end);
      } else {
        mergedMs += curEnd - curStart;
        curStart = iv.start;
        curEnd = iv.end;
      }
    }
    mergedMs += curEnd - curStart;
    downtimeMsByAsset.set(assetId, mergedMs);
  }
  return downtimeMsByAsset;
}
