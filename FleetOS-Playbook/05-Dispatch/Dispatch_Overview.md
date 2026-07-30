# Dispatch — Overview

## Purpose
Give a dispatcher one live view of the fleet's day and the ability to act on it, replacing phone calls and SMS threads as the coordination mechanism between office and operator.

## Requirements (core, v1 — each a discrete, separately built capability)
- Live map view of every active asset.
- ETA per active job/delivery.
- Current stop / job status per asset.
- Idle time tracking per asset.
- Fuel level/consumption visibility (where OBD data is available).
- Operator score visibility (behavior-derived, feeding Fleet Health Score).
- Maintenance alerts surfaced directly in the dispatch view (an asset with an open critical fault should be visibly flagged before it's assigned new work).
- Route visibility/optimization suggestions.
- Attached unit location (via Fleet Graph pairing with a GPS-equipped asset, or its own tracking if independently equipped).
- Operator chat (office-to-operator and operator-to-office messaging within FleetOS, replacing SMS).
- Customer-job messaging status (internal record of communication about a job — not a customer-facing portal; see out-of-scope note below).
- Digital paperwork status (which jobs have completed proof/forms attached).

## Explicit separation: AI predictions are a distinct layer
Per founder direction, every capability above is a deterministic, directly-controlled dispatch capability. AI-driven predictions (which asset to assign, predicted delay risk, predicted maintenance impact on today's schedule) are a separate Fleet Intelligence layer presented alongside dispatch, never merged into or replacing the base dispatch view. A dispatcher must be able to fully dispatch a fleet with AI recommendations turned off.

## Workflows
- Dispatcher sees an asset flagged with an open maintenance alert on the assign dialog, and reassigns its planned job to another asset before dispatching — the reassignment is a Timeline event on both the job and both assets.
- Dispatcher messages an operator directly through FleetOS chat rather than SMS; the message thread is attached to that operator's shift/Timeline.

## Edge cases
- Asset goes offline (connectivity loss) mid-route: last-known position and status must be clearly marked as stale, not presented as live.
- Conflicting reassignment (two dispatchers acting on the same job simultaneously): last-write-wins is not acceptable here — the UI must surface the conflict rather than silently overwrite.

## Technical considerations
- Live map and status views are read models over Fleet Graph/Timeline data, refreshed via the Sync Engine — dispatch should never require polling the OBD layer directly.

## Acceptance criteria
- A dispatcher can complete a full day of assignment, reassignment, and communication using only the deterministic dispatch capabilities, with AI recommendations disabled.
- An asset with an open critical maintenance fault is visibly flagged in the dispatch view before it can be assigned new work (a warning, not necessarily a hard block, per business judgment call — see Compliance override pattern).

## Future expansion notes
- Full route optimization (multi-stop, multi-asset optimization) is listed here as a v1 capability at a basic level (suggested ordering); more advanced optimization (cost-based, time-window-constrained solving) is a deeper Fleet Intelligence investment appropriate for a later phase once basic dispatch is proven.

## Implementation notes (Dispatch milestone, `apps/api` + `apps/fleethq`)
A deliberately scoped-down first slice of this file's full v1 requirement list, chosen because it's the smallest real workflow that (a) makes Fleet Graph's `graph_relationships` table start getting real writes, and (b) gives a dispatcher something to actually click, rather than building every capability above at once.

**Built**: `Job` entity (title, description, optional Asset/Operator assignment, `JobStatus`: Unassigned/Assigned/Completed/Cancelled). `POST /v1/jobs` (create, optionally pre-assigned), `GET /v1/jobs`/`GET /v1/jobs/:id` (list/get, including nested Asset/Operator for display), `PATCH /v1/jobs/:id` (edit title/description/schedule), `POST /v1/jobs/:id/assign` (set/change/clear Asset and/or Operator independently — send `null` to unassign just one side), `POST /v1/jobs/:id/complete`, `POST /v1/jobs/:id/cancel`. A FleetHQ Dispatch page: job list, create/assign dialogs, complete/cancel with confirmation. Permissions: `dispatch:view/create/edit/assign/cancel`, matching this doc's Assign Jobs / Cancel Jobs / Reallocate Work language from `14-Security/Permissions_Model.md`.

**Fleet Graph's first real write path**: assigning a Job to both an Asset and an Operator opens a timed `OPERATED` GraphRelationship (per `01-Product/Fleet_Graph.md`'s "when an operator is assigned to an asset for a shift, a timed relationship is created automatically"); reassigning, completing, or cancelling the job closes it. `GraphRelationship` has no `jobId` column — open/close is derived by matching the Operator+Asset pair itself, not a foreign key back to the job, since adding that column was beyond this slice's scope.

**Bundled in the same milestone**: the `AttachedUnit` API (`GET/POST/PATCH /v1/attached-units`, `POST /v1/attached-units/:id/archive`) — CRUD-only, mirroring Asset/Operator exactly. It does **not** yet participate in Fleet Graph (`AttachedUnit -[PAIRED_WITH]-> Asset` is a separate, not-yet-built workflow — hitching/unhitching actions, specifically).

**Explicitly not built in this slice** (all of these remain real v1 requirements per this doc, just not yet): live map view, ETA/idle-time/fuel visibility, operator behavior score, route visibility/optimization, attached unit location via Fleet Graph, operator chat, customer-job messaging, digital paperwork status, and the entire AI-predictions layer. None of these are buildable yet without data sources that don't exist (live GPS/OBD telemetry, a DriverOS client, a Customer entity) — see `CHANGELOG.md` for the full reasoning.

## Implementation notes (Scheduling ahead + bulk run creation, `apps/api` + `apps/fleethq`)
The backend has always stored `Job.scheduledAt` and the board has always had a
three-way Today / Upcoming / History filter — but nothing in FleetHQ ever *set* a
schedule, so the Upcoming tab was permanently empty and a dispatcher couldn't
plan a run before the day it ran. That's now closed: the New-job dialog has a
"Scheduled for" datetime field (blank = today/unscheduled), which is all the
Upcoming view needs — a future `scheduledAt` lands the run under Upcoming, today
or unscheduled under Today.

**Bulk creation**: `POST /v1/jobs/bulk` creates many runs in one request, each
row an ordinary `CreateJobDto` validated and created through the same `create()`
path a single job uses (so timeline event, OPERATED relationship, operator
notification and `scheduledAt` all apply identically), with the same per-row
independence every bulk path in the product has — one bad row reports its own
error and the rest are still created. No new permission (dispatch:create). The
FleetHQ "Add multiple" dialog is deliberately the simplest thing that works: one
run title per line, plus a single shared date and pickup depot applied to all —
no spreadsheet, no column mapping — reporting per-line success/failure.

## Implementation notes (Live driver location, `apps/api` + both clients)
The "where is my driver right now" question — the top item on the not-built list above — now has a first, honest answer, using the DriverOS client (which didn't exist when this doc was first sliced) as the GPS source instead of waiting on OBD telemetry.

**Built**: an on-shift DriverOS tablet reports its device geolocation to `POST /v1/locations` on a ~45s heartbeat (best-effort, non-blocking; does nothing if geolocation is denied/unavailable or the context isn't secure, per CLAUDE.md's "enhancements never block a core workflow"). Only the *latest* fix is kept, denormalised onto the `Operator` row (`last_lat/last_lng/last_location_at`) — this is live telemetry, not a breadcrumb trail, and deliberately writes **no** Timeline event (a position a minute would drown the audit log). `GET /v1/locations` returns the fleet's last-known positions seen within a 12-hour live window; the FleetHQ Dispatch page shows them in an auto-refreshing "Live driver locations" panel, each row correlated to the operator's current job/asset and linking out to a map. New permissions `locations:report` (driver) and `locations:view` (office) keep GPS visibility independently grantable from the dispatch board itself.

The list panel was subsequently upgraded with a **live map** (`FleetMap`, Leaflet + OpenStreetMap tiles — no API key/provider account): each on-shift driver is a marker with a popup, auto-framed to the fleet, degrading to a blank canvas (with the textual list still shown) when the office is offline. **Deliberately still not built**: a route/breadcrumb history, ETA, and idle-time — those build on this position feed but aren't it. Driver location is personal information under the Privacy Act; the erasure path clears it (see `14-Security/Privacy_Data_Protection.md`).

**Update, 2026-07-28**: the dedicated Live Map / TV kiosk pages were removed from FleetHQ's navigation (product decision). The dispatch board's own "Live driver locations" panel is unaffected — it was always the plain list-plus-link-out card grid described above (`GET /v1/locations` under the hood), not the Leaflet map, and stays.

## Implementation notes (DriverOS v0 milestone, `apps/api`)
- `GET /v1/jobs` now also accepts `operatorId` and `status` filters — added specifically so DriverOS's Today screen can ask "show *my* currently-assigned job" (`operatorId=<self>&status=ASSIGNED`) rather than fetching the full company job list and filtering client-side. No new endpoint; this is additive query-param filtering on the existing list route.

**Resolved (Workshop milestone)**: "maintenance alerts surfaced directly in the dispatch view" is now real — the assign dialog's asset picker visibly flags any asset with an open, Critical-severity maintenance job, per this doc's acceptance criterion. See `06-Workshop/Workshop_Overview.md`'s implementation notes.

**One design choice worth flagging**: `Job` has no `archivedAt`. Unlike Asset/Operator/AttachedUnit, a Job's terminal states (Completed/Cancelled) already satisfy "no hard deletes" — every job stays visible in its final state permanently, so a separate archive flag would be redundant.

Full verification: `npm run lint`/`tsc -b`/`npm run build` clean on both apps; new e2e suite (`test/dispatch.e2e-spec.ts`) covering AttachedUnit CRUD, tenant isolation, permission enforcement, the Job assign→complete lifecycle, the GraphRelationship open/close behavior, and rejection of edits to a terminal job — all passing against real local Postgres (26/26 tests, up from 21). Manually verified in a live browser: created a job, assigned it to a real Asset and Operator, confirmed the "Assigned" status and names rendered, marked it complete, confirmed it moved to "Completed" with all actions correctly disabled.
