# Fleet Health Score

> **REMOVED (2026-07-23).** The 0–100 Fleet Health Score was removed after founder review — it read as a gimmick and hid the actionable facts behind a single number. The signals it aggregated (overdue maintenance, expiring compliance, due services) are still computed and surfaced directly where they're useful: the asset detail page, the Dispatch assign-warning, Operational Recommendations, and Reports uptime. This document is retained for historical context only; nothing described below is live.

## Purpose
Give a fleet manager an instant, honest read on how an asset (and the fleet as a whole) is doing, without requiring them to interpret raw data across maintenance, fuel, faults, tyres, and compliance separately.

## Requirements
- Per-asset Health Score, computed from: open faults, maintenance currency (is service overdue), tyre condition, compliance document status (registration/insurance/roadworthy currency from Digital Glovebox), and driving behavior signals where available (harsh braking/acceleration via OBD).
- Fleet-level rollup (Company Health Score) aggregating asset scores plus fleet-wide signals: operator compliance status, uptime, and cost trends.
- Score must be explainable — a manager can always see exactly which factors are dragging a score down, never just a number with no reasoning.
- Score updates in near-real-time as new Timeline events occur (a new fault immediately affects the relevant asset's score).

## Workflows
- Manager opens FleetHQ dashboard, sees fleet sorted by Health Score, lowest first, and can drill into any asset to see exactly why it's scored the way it is.
- An asset whose registration is about to expire sees its score drop ahead of the expiry, not after — the score is forward-looking where the underlying data supports it (e.g. days-until-expiry, days-until-service-due).

## Edge cases
- Missing data (e.g. an asset without OBD connectivity yet): score must degrade gracefully and be transparent about which factors couldn't be assessed, rather than defaulting to a misleadingly high or low score.
- Sudden score swings from a single event (one new fault tanking the score): weighting must be reviewed so the score reflects genuine severity, not just event count.

## Technical considerations
- Score computation reads from the Fleet Graph / Timelines rather than maintaining a separate, easily-out-of-sync data store.
- Scoring weights should be configurable at a platform level (not hardcoded per customer) so the methodology can be tuned as real-world data comes in.

## Acceptance criteria
- Every asset with at least basic Digital Glovebox and checklist data produces a Health Score with a visible breakdown of contributing factors.
- Score changes are traceable to specific Timeline events.

## Future expansion notes
- Predictive scoring (Fleet Intelligence forecasting a score's trajectory, e.g. "will likely drop below threshold in 10 days") builds naturally on this once historical data volume supports it.

## Implementation notes (Fleet Health Score milestone, `apps/api` + `apps/fleethq`)
- Built a deliberately scoped slice of this file's own requirements list: a per-asset score derived from **open Maintenance jobs** and **Compliance document expiry** only — the two factors with real data behind them today. Tyre condition and OBD-derived driving behavior have no data source yet (no telemetry, no checklist-sourced tyre data) — not included, not faked with placeholder values.
- Score starts at 100 and is reduced by fixed deductions: an open Critical maintenance job -35, an open Normal maintenance job -10 (summed across all open jobs on the asset); a Compliance document already expired -30, or expiring within 30 days -10 (worst case only, not summed per document). Clamped to [0, 100]. Computed at read time from existing data, never stored — same "zero duplicate data entry" reasoning as Compliance's own expiry status (`08-Compliance/Australian_Compliance.md`).
- **Explainable by construction, not as an afterthought**: every score is returned with its full factor breakdown (`status` + human-readable `detail` string) — the API has no "just a number" response shape at all, directly satisfying this file's "never just a number with no reasoning" requirement.
- **Missing-data transparency** (this file's own edge case): an asset with zero open maintenance jobs is scored `ok` (a genuine positive signal). An asset with zero compliance documents logged is scored `not_assessed` (deduction 0) rather than a misleadingly perfect 100 — the distinction matters: "nothing wrong" and "nothing known" are not the same state, and the breakdown says which one applies.
- **Permission-aware factor visibility**: a factor is only assessed if the caller holds the permission that would let them see the underlying data directly (`maintenance:view` / `compliance:view`); otherwise it's marked `not_permitted` (deduction 0) rather than leaking "this asset has an open critical fault" to a role that couldn't see Maintenance records directly. New shared `PermissionCheckerService` extracts the same permission-lookup query `PermissionGuard` already uses, for exactly this in-service (not route-level) check. See `14-Security/Permissions_Model.md`.
- `GET /v1/fleet-health` (gated on `assets:view`, since a Health Score is fundamentally an Asset property) returns the whole fleet: per-asset scores with breakdowns, sorted worst-first per this file's own "sees fleet sorted by Health Score, lowest first" workflow, plus a fleet-level average and an at-risk count (score < 70).
- FleetHQ: the Dashboard's Fleet Health Score placeholder widget is now real (average + at-risk badge, links through to a full sorted breakdown page at `/fleet-health`). Not given its own sidebar nav entry — same precedent as Fleet Graph, a Dashboard-anchored feature reached by drilling in, not a top-level module.
- Not built: tyre condition, OBD-derived driving behavior, predictive scoring (all named above as deliberate future work), and configurable scoring weights (currently fixed constants, matching this file's "should be configurable at a platform level" as a documented future step, not a day-one requirement).
- **The Purpose section's "Company Health Score" fleet-wide rollup (operator compliance status, uptime, cost trends) is still not a single unified rollup object** — but two of its three named signals now exist as real, separately-computed figures on the Reports page (`07-FleetHQ/FleetHQ_Overview.md`'s Reporting depth implementation notes): fleet uptime % and maintenance cost trend, both over the same reporting date range rather than as a live Dashboard score. Folding these (plus operator compliance status) into one Company Health Score object is a reasonable next step, not attempted here.
