/**
 * Safety ceiling for internal aggregations that load rows to reduce in JS
 * (group/count/merge) rather than paginating a client-facing list. It bounds
 * worst-case memory and latency on high-growth tables (notifications, timeline
 * events, compliance documents, checklist submissions, reporting rollups)
 * flagged by the production-readiness audit as the top scaling risk.
 *
 * Deliberately set well above any realistic single-tenant working set for the
 * windows these queries scope to (a day, a current-validity set, one job's
 * events), so the cap only ever bites pathological data — at which point the
 * aggregate becomes approximate rather than the process falling over on an
 * unbounded read. Where a client genuinely needs to walk a large result set,
 * the endpoint paginates instead (see ListQueryDto); this constant is only for
 * the aggregate-in-JS reads that don't.
 */
export const MAX_AGGREGATION_ROWS = 10_000;
