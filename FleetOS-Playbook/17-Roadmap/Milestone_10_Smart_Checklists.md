# Milestone 10 — Smart Checklists

> Scope document for the tenth product milestone. Written in the honest,
> scoped-down voice of `CHANGELOG.md`, not the neutral spec voice — this records
> *what we chose to build and why*, and just as importantly what we deliberately
> did not. The source-of-truth spec is `01-Product/Smart_Checklists.md`.

## Why this milestone, now

Smart Checklists had been queued and deliberately deferred through the two
previous DriverOS milestones (DriverOS v0 and Digital Glovebox), each of which
picked a smaller, purely-additive slice specifically to avoid it. The reason it
kept being deferred is the reason it matters: it is **the first DriverOS
workflow with operator-editable state** — a checklist is filled in
progressively, not fired off in one shot like a fault report — and the
offline-sync engine v0 explicitly punted on anything editable. This milestone
takes that on.

## The forcing function, and how it's resolved

The offline-sync engine v0 (`apps/driveros/src/lib/offline-db.ts`) was create-only
and stated outright it had "no conflict resolution … nothing to conflict yet."
A progressively-filled checklist breaks that assumption. This milestone resolves
it deliberately, and narrowly:

- **In-progress answers are editable local state.** A new IndexedDB
  `checklistDrafts` store persists every answer the instant it's made and
  reloads it on return, so losing/regaining connectivity mid-flow never loses
  captured answers — the spec's headline edge case.
- **The submission surface stays a single immutable create.** Only the
  *completed* checklist is sent, as one `POST /v1/checklist-submissions`, through
  the existing create-only outbox. So there is still exactly one writer per
  checklist (one operator, one device) and **no multi-writer conflict to
  resolve** — we did not invent last-write-wins merge machinery this slice
  doesn't need.
- **The real conflict surface here is template drift**, and it's resolved by
  **version snapshotting**: the submission records the exact `items` array the
  operator saw and answered (sent by the client, which may have been offline
  against an older cached template) plus the template `version`. An office-side
  template edit therefore never rewrites a completed — or in-progress —
  checklist. Editing a template bumps its `version`; renaming it does not.
- **Replays are idempotent.** The client generates the submission `id`; a
  duplicate id on outbox replay after a lost response is a no-op, never a second
  checklist (or a second auto-created workshop job).

Genuine multi-device concurrent editing of the same checklist remains out of
scope, and is called out as such — honest scoping, not an accident.

## What's built

**Backend (`apps/api`)**
- `ChecklistTemplate` — company-scoped, versioned, `archivedAt` reference-record
  lifecycle (same as ComplianceDocument). `items` is data-driven JSON. Optional
  `appliesToAssetClass` (by key) so a Land pre-start is scoped by class from day
  one.
- `ChecklistSubmission` — immutable, append-only. The app role is granted only
  `SELECT, INSERT` (never UPDATE/DELETE), so immutability is *structural*, the
  same mechanism `timeline_events` relies on. Stores its own `templateSnapshot`
  + `templateVersion`.
- Endpoints: `POST/GET/GET:id/PATCH:id/POST:id/archive` on `checklist-templates`,
  `POST/GET/GET:id` on `checklist-submissions`. `GET checklist-templates?assetId=`
  resolves the applicable templates for an asset by its class (DriverOS), so the
  same API a third-party would use serves both clients.
- Downstream action: a failed item flagged `createsFaultOnFail` creates a
  workshop `MaintenanceJob` inline in the same transaction (not via
  `MaintenanceService`, which opens its own — so the checklist and its faults
  commit atomically). This satisfies the spec's headline acceptance criterion:
  one operator interaction produces a workshop job with no further data entry.
- Every completed checklist writes Timeline events on the **asset** and the
  **operator** (plus the submission itself), per "every entity has a timeline."
- New permission category `checklists` (`view/create/edit/archive/submit`).
  Operator identity on submit is resolved server-side from the JWT's linked
  Operator — never trusted from the client.

**DriverOS (`apps/driveros`)**
- A new offline-first Pre-Start Checklist screen, reached from Today via the same
  `?assetId=&assetName=` pattern Fault Reporting and Digital Glovebox use.
- `checklistDrafts` IndexedDB store + helpers; network-first-then-cache for the
  applicable templates so a synced operator can still run their checklist in a
  dead zone.

**FleetHQ (`apps/fleethq`)**
- A new Checklists module (nav + page): a Templates tab with a structured item
  editor (add/reorder/remove items, per-item type and the two fail-follow-up
  toggles) using the archive-as-correction lifecycle, and a Completed tab
  showing operator submissions with a read-only detail view rendered from each
  submission's own snapshot.

## Deliberately NOT built (stated up front)

- The full Universal Forms drag-and-drop template builder — a structured item
  editor stands in.
- A general conditional-branching engine — the only data-driven follow-ups are
  `requireNoteOnFail` and `createsFaultOnFail`. ("Fail → note required → workshop
  job" is a real, if minimal, branch.)
- Photo / location / measurement capture — no photo store exists yet (Fault
  Reporting didn't build one either).
- A dedicated Notifications system — the auto-created MaintenanceJob *is* the
  workshop's queue, the same substitution Workshop and Compliance made. "Notify
  the workshop" is satisfied without a notifications subsystem that has no spec
  or data model yet.
- Multi-device concurrent-edit conflict resolution / server-side partial-draft
  sync.
- Checklist scheduling/assignment (which asset must run which checklist, when).
  DriverOS surfaces the templates that apply to the current asset's class.
- AI-assisted photo analysis (an explicit Fleet Intelligence future layer).

## Operational note — seed-script permission drift (again)

Adding the `checklists:*` category means pre-existing Administrator roles do not
gain it automatically (documented behaviour: `provisionCompany` grants only the
permissions that exist at provision time). Newly signed-up companies get it; any
pre-existing dev/test Administrator needs it granted via the Roles UI. E2e tests
sidestep this by granting explicit permission sets per tenant.

## Verification

- Backend: 8 new e2e specs in `test/checklists.e2e-spec.ts` (template
  versioning, applicable-template-by-class, the fail→workshop-job acceptance
  criterion, snapshot immutability across a later edit, idempotent replay, the
  fail→note-required branch and answer validation, tenant isolation, route
  permissions). Suite: **67/67 passing across 15 suites** (up from 59/14).
  Typecheck + lint clean.
- Both frontends build, typecheck, and lint clean.
- Verified live against a real local Postgres on the booted server: signup →
  create template → create asset → submit a checklist with a failed item →
  confirmed the workshop MaintenanceJob was auto-created and the submission
  recorded its own version snapshot.
