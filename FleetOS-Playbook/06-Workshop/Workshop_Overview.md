# Workshop Hub — Overview

## Purpose
Give workshop staff one place to see what needs fixing, why, and with what history — fed automatically from Smart Checklists, OBD/CAN fault data, and manual reports, instead of a separate paper service book.

## Requirements
- Incoming job queue: faults/damage reports from Smart Checklists and OBD/CAN, plus manually logged issues, all landing in one workshop queue.
- Each job links back to its source (which checklist, which OBD fault event, which form submission) and to the asset's full maintenance Timeline.
- Scheduling: service-due tracking (time or distance-based intervals, configurable per asset type) feeding proactively into the queue before something breaks, not only reactively after a fault.
- Job lifecycle: open → in progress → parts pending → complete, each transition a Timeline event, with permission-gated approval steps where a company requires sign-off before spend (per Modular Permissions' Maintenance: Approve capability).
- Asset availability flag: an asset with an open, severity-flagged job is marked unavailable for dispatch until cleared (working with Dispatch's maintenance alert surfacing).

## Workflows
- A Smart Checklist "tyre damaged" branch creates a workshop job automatically, pre-populated with the photo, tread measurement, and asset ID — a technician picks it up without re-entering anything an operator already reported.
- Technician closes a job, logs parts used and labor time; this becomes part of the asset's permanent maintenance Timeline and feeds Fleet Health Score.

## Edge cases
- Duplicate reports of the same underlying fault (operator reports it twice, or OBD flags it repeatedly): should be merged/linked rather than creating redundant duplicate jobs.
- Job requiring parts not in stock: needs a "parts pending" state that doesn't misrepresent the asset as available, and doesn't get lost/forgotten in the queue.

## Technical considerations
- Workshop jobs are themselves Fleet Graph entities, linked to assets, operators (who reported), and the triggering event — enabling questions like "which faults most often lead to a workshop job vs. resolve on their own."

## Acceptance criteria
- Every workshop job is traceable to its origin (checklist, OBD event, or manual report) without manual cross-referencing.
- An asset with an unresolved, severity-flagged job is correctly reflected as unavailable in Dispatch.

## Future expansion notes
- Parts inventory management and supplier integration (`10-Integrations/`) is a natural extension once core workshop workflow is proven — not required for v1 to be useful.

## Implementation notes (Workshop milestone, `apps/api` + `apps/fleethq`)
A deliberately scoped-down first slice, chosen for the same reason Dispatch was scoped down: build the smallest real version of the workflow rather than everything this doc describes at once.

**Built**: `MaintenanceJob` entity (title, description, an asset it's against, `MaintenanceSeverity`: Normal/Critical, a linear `MaintenanceJobStatus` lifecycle: Open → In Progress → Parts Pending → Complete, an optional `reportedByOperatorId`, and `resolutionNotes` recorded on close). `POST/GET /v1/maintenance-jobs`, `GET/PATCH /v1/maintenance-jobs/:id` (edit details/non-terminal status), `POST /v1/maintenance-jobs/:id/approve`, `POST /v1/maintenance-jobs/:id/close`. Permissions: `maintenance:view/create/edit/approve/close`, matching `14-Security/Permissions_Model.md`'s own Maintenance example list (View/Create/Schedule/Approve/Close — Schedule isn't implemented, see below). A FleetHQ Maintenance page: job list, log-job dialog (asset select, severity), inline status changes, approve/close actions.

**The Dispatch integration this doc's acceptance criteria calls for is real, not just documented**: the Dispatch "Assign" dialog's asset picker now visibly flags (warning icon + inline text) any asset with an open, Critical-severity maintenance job — read-model only, no coupling between the Assets/Dispatch/Maintenance modules' write paths.

**Approval is recorded, not a hard gate**: `approve` stamps `approvedAt`/`approvedByUserId` as its own Timeline-worthy action, satisfying "permission-gated approval steps" as a real, checkable fact — but closing a job doesn't require prior approval. This doc's phrase "where a company requires sign-off" implies a per-company configurable policy, which is more than this slice builds; enforcing approval-before-close is a natural next step once that setting exists.

**Explicitly not built in this slice**: Smart Checklist and OBD/CAN auto-creation of jobs (neither data source exists yet), service-due scheduling (needs odometer/last-service fields on Asset that don't exist yet — the "Schedule" permission from `14-Security/Permissions_Model.md`'s example list is defined in code as `maintenance:edit` covering manual status changes, not true proactive scheduling), duplicate-report merging, parts inventory, and the job-links-back-to-its-triggering-checklist/OBD-event requirement (nothing yet triggers a job automatically to link back to).

Full verification: lint/typecheck/build clean on both apps; new e2e suite (`test/maintenance.e2e-spec.ts`) covering the full create→edit→approve→close lifecycle, terminal-state rejection, tenant isolation, and permission enforcement — 33/33 tests passing across 9 suites, up from 26/8. Manually verified in a live browser: logged a Critical job against a real asset, confirmed it appeared flagged in the Dispatch assign dialog, approved it, closed it with resolution notes, confirmed the terminal "Complete" state with all actions correctly disabled.

## Implementation notes (Reporting depth's cost trend, `apps/api` + `apps/fleethq`)
- **Built**: this doc's "Technician closes a job, logs parts used and labor time" line now has a real number behind it — `partsCost`/`laborCost` (both optional) are captured on `POST /v1/maintenance-jobs/:id/close` and stored on the job, feeding `17-Roadmap/Product_Roadmap.md`'s v1.x "cost trend analysis" line in the Reports page (`01-Product/Fleet_Health_Score.md`'s "cost trends" component of the fleet-wide rollup also reads from this). No new permission — closing already required `maintenance:close`.
- **Superseded by the Parts inventory basics slice below**: itemized parts (a list of specific parts and quantities, not just a single manually-entered total) is now built — see that section. `partsCost` remains as a manual override for costs not tied to a tracked part (e.g. a one-off part not worth adding to the catalog); it is not automatically summed from tracked parts usage in this slice (a documented limitation, not a silent gap — see below).

## Implementation notes (Parts inventory basics, `apps/api` + `apps/fleethq`)
- **Built**: this doc's own "Future expansion notes" line ("parts inventory management ... is a natural extension once core workshop workflow is proven") — a `Part` catalog (name, optional part number, `quantityOnHand`, optional `unitCost`, optional `lowStockThreshold`) with the same CRUD-plus-archive shape as Depots/Customers, gated on new `parts:view/create/edit/archive` permissions. `POST /v1/maintenance-jobs/:id/parts-used` logs a part used against a job — decrementing `Part.quantityOnHand`, snapshotting `unitCostAtUse` on the log line (so a later catalog price change doesn't retroactively rewrite what a past job actually cost), and recording a Timeline event on both the job and the part. Allowed any time before the job is closed (`MAINTENANCE_JOB_CLOSED` once it is), gated on `parts:create` (logging usage is the same capability as creating an inventory transaction, not a Maintenance-module capability) rather than a new permission.
- **Insufficient stock is rejected, not allowed to go negative**: `INSUFFICIENT_STOCK` (409) if the requested quantity exceeds `quantityOnHand` — the fix is a stock adjustment (a direct `PATCH /v1/parts/:id` edit to `quantityOnHand`, e.g. after a restock or stocktake) before logging the usage, not a negative-stock allowance.
- **Low-stock flagging**: every Part response includes a derived `isLowStock` (`quantityOnHand <= lowStockThreshold`, only when a threshold is set) — computed at read time, nothing new stored, same "explainable, not stored" precedent as Fleet Health Score.
- **FleetHQ**: a third "Parts" tab on the Maintenance page (catalog table, low-stock warning icon, add/edit/archive), and a "Log parts" row action on the Jobs tab (gated `parts:create`, disabled once a job is closed) opening a small dialog to pick a part and quantity — already-logged usage shows as a compact summary line under the job's title (e.g. "2× Brake pads").
- **Deliberately not built** (this doc's own "Future expansion notes" still correctly names these as later work, not this slice): supplier integration, reorder automation/purchase orders, multi-location stock (a single `quantityOnHand` per company), and automatically rolling tracked-parts-usage cost into the manual `partsCost` figure the Reporting-depth slice above added — logging usage and entering a manual cost are two independent paths today, and using both for the same spend on one job would double-count in the Reports cost trend. A future increment could compute `partsCost` automatically from usage records when any exist; not attempted here.

4 new e2e tests (catalog create/edit/stock-adjustment/archive, logging usage with stock decrement and unit-cost snapshot, insufficient-stock rejection, rejection once a job is closed, tenant isolation, permission gating). Live-tested end-to-end in a real Playwright-driven browser session: created a part with a low-stock threshold, logged more than the threshold's worth of usage against a real job, and confirmed the job's title showed the usage summary, the Parts tab showed the low-stock warning icon, and the stock count matched exactly.
