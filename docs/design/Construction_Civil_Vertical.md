# Construction & Civil Vertical — Design Note (Brief #2, Part 1)

Status: Draft (design-before-code). Author: Engineering.
Scope of this document: the **design** for Part 1 §1 (industry-configuration
foundation) and the **explicit written decision** for §7 (project/site
grouping), plus a **reuse map** for §2–§6 and §8. **No feature code is
implemented by this note.** All citations are `api/prisma/schema.prisma` unless
another path is given; line numbers are as of the branch this note lands on.

This note **builds on** ADR 0002 (`docs/adr/0002-industry-packs-and-combined-accounts.md`):
one `Company`/tenant, the construction vertical is an **entitlement pack**
(`pack_construction`) gated by the **existing** `@RequireFeature(...)` /
`FeatureGuard`, data lives under the same `company_id` behind the same RLS
boundary. Nothing here reopens the tenant-isolation model.

---

## 1. Scope guardrails (out-of-scope, restated from the brief)

FleetHQ Construction is the **best owned-plant / equipment-&-compliance
operations tool** for a civil contractor. It is explicitly **not** a
project-management or budgeting suite. The following are **out of scope** for
this vertical and must not be built under it:

- **NOT project management / budgeting** — no cost codes, no budget-vs-actual,
  no job costing, no financial forecasting. (Existing `MaintenanceJob.partsCost`
  / `laborCost` (`schema.prisma:1772-1773`) stay scoped to workshop cost, not
  project accounting.)
- **NOT Gantt / scheduling portals** — no critical-path planning, no
  dependency graphs, no client/subcontractor portal. (This matches the standing
  "no customer login/portal/self-service" boundary already asserted on
  `Customer`, `schema.prisma:1440`.)
- **NOT a rental / booking engine** — no availability calendar, reservations,
  hire-rate billing, or marketplace. Plant is **owned**, tracked as `Asset`
  rows; the vertical manages *compliance and maintenance of owned plant*, not
  hire transactions.
- **NO AI in this pass.** Every construction feature must have a working,
  **deterministic** core with no ML/LLM in the decision path — consistent with
  the existing predictive-maintenance module, which is deliberately a
  rule-based detector with "no AI/ML model involved at all"
  (`src/predictive-maintenance/predictive-maintenance.service.ts:30-47`).
  **Reason it is a hard line, not just a preference:** the Australian Privacy
  Act (as amended, automated-decision-making transparency reforms) imposes
  **disclosure obligations** where personal information is used in automated
  decisions that significantly affect an individual (e.g. an operator). Shipping
  AI into compliance/maintenance decisions now would pull that disclosure
  obligation into scope before the vertical's core exists. AI enhancement, if
  ever added, is a separately-scoped pass with its own privacy review.

---

## 2. §1 Industry configuration — the foundation

Everything else in this vertical sits on this. The job of §1 is: a company's
**primary industry** + its **enabled packs** (resolved from entitlements per
ADR 0002) select **three defaults** — a **terminology set**, a
**checklist/compliance template pack**, and a **landing dashboard** — each of
which a tenant may **override**.

### 2.1 What already exists that this reuses

- **`Company.industry`** (`schema.prisma:235`) — today a **nullable free-text
  String**, "descriptive only, never used to gate a feature." Per ADR 0002 §2 it
  becomes the **default/primary pack + terminology/dashboard driver**, *not*
  access control. We keep it as the free-text primary label and read the
  **enabled-packs list from entitlements** (`billing/plans.ts` `FeatureKey`,
  line 20) — never from this string.
- **The "Saved Layout / deployable" pattern**, which already appears five times
  and is exactly the override mechanism §1 needs:
  - `DashboardLayoutPreset` (`schema.prisma:507`) — ordered widget keys +
    `isDefault` (line 511), "deployable to many members' dashboards"; a member's
    own arrangement lives on `CompanyMembership.dashboardLayout`. Widget catalog
    in `src/dashboard-layouts/dashboard-widgets.ts`.
  - `ChecklistBundle` / `ChecklistBundleItem` (`schema.prisma:408` / `424`) —
    "assemble a set of checklists once, then deploy the whole set to an asset
    class in one action."
  - `NotificationPreset` (`schema.prisma:487`), `MaintenanceScheduleTemplate`
    (`schema.prisma:1106`), `FatigueRuleSet` (`schema.prisma:522`) — same
    named-set + deploy + `isDefault`-fallback shape.
- **The built-in-vs-tenant override pattern** on `AssetClass`
  (`schema.prisma:938`): a **global built-in** row has `companyId = NULL` and is
  read by every tenant; a company that wants it gone inserts a `HiddenAssetClass`
  suppression row (`schema.prisma:~983`) rather than deleting the shared row.
  This is the precedent for shipping **built-in construction defaults** without
  seeding per-tenant copies.
- **The versioned JSON-schema template engine** — `ChecklistTemplate`
  (`schema.prisma:2193`, `version` + `items` JSON + `appliesToAssetClassId`) and
  `FormTemplate` (`schema.prisma:2296`, `version` + `fields` JSON + snapshot on
  submit) — the carrier for the template pack (see §4/§6).

### 2.2 Gap this section must fill (the one primitive the brief assumed that does not exist)

**There is no terminology / label-map mechanism anywhere.** `grep` for
`terminolog|labelMap|nomenclature` finds only a source-comment (`schema.prisma:2`),
no model, no service. So §1's terminology set is **net-new**, but it should be
built in the shape of the existing preset pattern, not as a bespoke system.

### 2.3 Proposed data model for §1

Three thin pieces, all tenant-scoped, all following existing patterns:

1. **`IndustryPackDefinition` (code-level, not a table).** A static in-repo
   registry (like `billing/plans.ts` and `dashboard-widgets.ts`) keyed by pack
   (`pack_construction`, …) that names, for each pack, its **default terminology
   map**, the **id/keys of its built-in template bundle**, and its **default
   dashboard preset**. Ships in code, versioned with the app — no migration,
   no per-tenant seed. This is the "primary industry + enabled packs → defaults"
   resolver ADR 0002 §2 calls for.

2. **`TerminologyOverride` (new table).** `companyId`, `key`, `value`
   (e.g. `job → "Site Task"`, `depot → "Yard"`, `asset → "Plant"`). Resolution
   order at read time: tenant override → primary-pack default (from the code
   registry) → base transport label. Same "override row on top of a built-in
   default" shape as `HiddenAssetClass`. The frontend/DriverOS render labels
   through a single resolved terminology map (ADR 0002 §4: "UI is pack-aware,
   not pack-forked"). **Needs its own migration.**

3. **Default template pack + default dashboard = existing tables, seeded as
   built-ins.** The construction checklist/compliance bundle is a
   `ChecklistBundle` of `ChecklistTemplate`s; the landing dashboard is a
   `DashboardLayoutPreset` with `isDefault = true`. Where a pack default should
   be a **global built-in** (available to every construction tenant without a
   per-tenant copy), extend the `companyId`-nullable built-in pattern already
   used by `AssetClass` to these tables; where a customer edits it, that is a
   normal tenant-owned row. Per-tenant override is then **free** — it is the
   deploy/`isDefault` behaviour these tables already have.

**Why this shape:** it reuses the deploy + `isDefault`-fallback + built-in
suppression machinery verbatim; the only genuinely new surface is the
terminology map, and even that mirrors an existing pattern. It keeps `industry`
as a label and drives behaviour off entitlements, exactly as ADR 0002 mandates.

---

## 3. §7 Project/Site grouping — explicit decision

**Question:** can a construction **project/site** be represented by
`Depot`/`Job` **by configuration**, or does it warrant a **new `Site` (Project)
entity**?

### 3.1 What the candidates actually are

- **`Depot`** (`schema.prisma:1333`) — "the fleet's OWN pickup locations —
  depots, warehouses, branches." A reference record (`name`, `address`, `notes`,
  `archivedAt`); its only relation is `jobs Job[]` as a **pickup origin**
  (`Job.pickupDepotId`, `schema.prisma:1298`). It is a *place a run starts
  from*, not a container that assets, compliance, and work attach to.
- **`Job`** (`schema.prisma:1290`) — a single dispatch run: one optional
  `assetId`, one optional `operatorId`, a `status` (`JobStatus`,
  `schema.prisma:1274`), and ordered `JobStop`s (`schema.prisma:1481`). It is a
  **unit of delivery work with a terminal lifecycle**, not a long-lived grouping.

### 3.2 Decision: **a new first-class `Site` (Project) entity.**

A construction site is a **long-lived container** that many things attach to
over months: multiple pieces of plant on site, site-specific compliance (permits,
SWMS, site inductions), inspections, and maintenance performed on site.
Neither candidate models that:

- **`Depot` can't** — it is a point-of-origin reference record with no
  attachment surface; a site is not "where a run starts."
- **`Job`-by-configuration can't** — a `Job` is a single-asset, single-operator
  run with a **terminal** status (`COMPLETED`/`CANCELLED`). Forcing a
  months-long, many-asset site onto it means overloading `status`, faking the
  one-asset relation into a many-asset one, and breaking the delivery reporting
  that reads `Job`/`JobStop` shape (`src/reports/reports.service.ts`). That is
  exactly the "overload an entity that means something else" trap.

**Justification against the required axes:**

- **RLS / tenant impact:** none new. `Site` is an ordinary tenant table with
  `companyId` + the standard RLS GUC via `withTenant`, identical to every model
  above. No change to the isolation boundary (ADR 0002's whole point).
- **How things attach:** `Site` becomes the grouping key other entities
  **reference by nullable FK**, additively — `Asset.siteId?` (plant currently on
  a site), `MaintenanceJob.siteId?`, `ComplianceDocument.siteId?` (site permits),
  `Job.siteId?` (a run serving a site). Every FK is **nullable**, so a
  transport-only tenant and all existing rows are unaffected — the same additive
  discipline `StopParcel`'s barcode columns used (`schema.prisma:~1540`).
- **Reporting:** grouping by site is then a normal within-tenant `WHERE site_id
  = …` filter — pack sectioning is "a filter, not a join across tenants"
  exactly as ADR 0002 §3 frames it. It composes with the §6 report builder
  (site becomes a group-by dimension) rather than needing bespoke rollups.

`Site` is deliberately **not** a project-management object — no schedule, no
budget, no Gantt (§1 guardrails). It is a **compliance/plant container with a
location and a lifecycle status**. **Needs its own migration** (new table +
the nullable FK columns on `Asset`/`MaintenanceJob`/`ComplianceDocument`/`Job`).

---

## 4. Reuse map for §2–§6 and §8

Each names the **exact existing primitive** the section **extends, not replaces.**

**§2 — Tenant-configurable compliance document types.** Today
`ComplianceDocumentType` is a **fixed Prisma enum** (`schema.prisma:2100`:
`REGISTRATION`, `INSURANCE`, `ROADWORTHY`, `LICENCE`, `MEDICAL_CERTIFICATE`),
validated by `@IsEnum(ComplianceDocumentType)` in the compliance DTOs
(`src/compliance/dto/create-compliance-document.dto.ts:14-15`,
`update-compliance-document.dto.ts:6-7`) and stored on `ComplianceDocument.documentType`
(`schema.prisma:2132`). Construction needs tenant-defined types (plant registration,
site permit, SWMS, prestart cert). **Extend by** introducing a
tenant-configurable `ComplianceDocumentType` **table** (built-ins + per-tenant
rows, the `AssetClass` built-in pattern) and changing `documentType` from an
`enum` column to a FK/string keyed on it — keeping the existing expiry-sweep and
alert idempotency logic (`expiringAlertedAt`/`expiredAlertedAt`,
`schema.prisma:2150-2151`) untouched. **Migration required** (enum → configurable
reference).

**§3 — Usage-hour maintenance triggers, into the existing work-order lifecycle.**
The work-order lifecycle is `MaintenanceJob` (`schema.prisma:1750`,
`MaintenanceJobStatus` at `1735`), already auto-created from a failed checklist
item (`ChecklistSubmission` "createsFaultOnFail as fail spawns a MaintenanceJob
through the existing Workshop module", `schema.prisma:2231-2234`). Recurring
maintenance is `AssetMaintenancePlan` (`schema.prisma:1130`), which is
**time-based only** — `intervalDays` (line 1136), next-due from `lastServiceAt`
+ interval. **Extend by** adding a **usage-based interval** to
`AssetMaintenancePlan` (e.g. `intervalHours` / `intervalKm` + a
`lastServiceMeter`) and having the due-check raise a `MaintenanceJob` when the
asset's meter crosses the threshold, reusing the identical
`dueAlertedAt`/`overdueAlertedAt` idempotency the time-based sweep already uses
(`schema.prisma:1143-1144`) and the `SchedulerService` sweep that drives it.
**Gap the brief assumed:** usage is only **partially** captured — `Asset.odometer`
is a **single current reading** with "a full reading-history table is future
work" (`schema.prisma:1008`, comment at `:997-999`), and `FuelEntry.odometerReading`
(`schema.prisma:2505`) is point-in-time; **there is no engine-hours field and no
meter-reading history anywhere.** §3 therefore also needs a lightweight
meter-reading capture (engine hours / odometer, historied) as the trigger's data
source — flag this as real new capture, not just a plan tweak. **Migration required.**

**§4 — Construction checklist / compliance templates.** Ride directly on the
**versioned JSON-schema form/checklist engine**: `ChecklistTemplate`
(`schema.prisma:2193`, `version` + `items` JSON, class-scoped via
`appliesToAssetClassId`, immutable snapshot on submit) and `FormTemplate`
(`schema.prisma:2296`). Construction prestart/inspection/SWMS templates are new
**rows/bundles** (a `ChecklistBundle`, `schema.prisma:408`) shipped as the §1
default pack — **no engine change, no migration** beyond seeding built-ins.

**§5 — Camera asset tagging (repoint the scan engine at Assets).** The
scan-matching engine is `src/barcode/barcode-matching.ts` (`decodeScan`,
`BUILTIN_FIELD_COLUMNS`) + `BarcodeSearchableField` (`schema.prisma:1655`),
`BarcodeFieldMapping` (`schema.prisma:1679`), `BarcodeScanConfig`,
`BarcodeFieldTarget` (`schema.prisma:1622`); the DriverOS camera scan
(`fleethq-driveros/src/features/delivery/scan-submit.ts`, using
`@capacitor-mlkit/barcode-scanning`) funnels every scan through one path
(`scanStopParcel` → `POST …/parcels/scan`). **Today it is hard-wired to
`StopParcel`**: `BUILTIN_FIELD_COLUMNS` maps every searchable key to a
`StopParcel` column, `BarcodeFieldTarget` values are all parcel/delivery fields,
and `BarcodeScanEvent.matchedParcelId` (`schema.prisma:~1717`) records the match
as a parcel. **Extend by** generalising the **match target** so a scan can
resolve an **`Asset`** (by `registration`/`vin`/`customFields`,
`schema.prisma:1004-1010`) — a second searchable-entity option and a second
server match endpoint, **reusing** `decodeScan`, the searchable-field/mapping
config, and the single-scan-path discipline. **Gap the brief assumed:** the
scan engine is not entity-agnostic today — repointing is a real generalisation
(new match target + likely a nullable `matchedAssetId` on the event), not just a
config toggle. **Migration likely required.**

**§6 — Minimal ad-hoc report builder (as a reusable platform capability).**
Existing reporting is `src/reports/` — `ReportsService.operations`/`impact`
are **fixed-shape read-models** over grouped SQL inside `withTenant`, with a
pure aggregation helper (`report-aggregation.ts`) and row caps
(`MAX_AGGREGATION_ROWS`). **There is no ad-hoc/custom report builder** — the
report shapes are hard-coded. **Extend by** adding a small, **generic**
group-by/filter/date-range builder over the same `withTenant` + grouped-SQL +
row-cap foundation, exposed as a **platform capability** (usable by any
vertical, with `Site` from §7 as one available group-by dimension) rather than a
construction-only report. **Gap:** the reusable builder is net-new on top of the
fixed reports; the reuse is the *aggregation/tenancy plumbing*, not an existing
builder. **Migration:** only if custom report definitions are persisted.

**§8 — Configurable statuses / lightweight workflow for Jobs & Maintenance.**
Both status sets are **fixed enums** today: `JobStatus` (`schema.prisma:1274`:
`UNASSIGNED`/`ASSIGNED`/`COMPLETED`/`CANCELLED`) and `MaintenanceJobStatus`
(`schema.prisma:1735`: `OPEN`/`IN_PROGRESS`/`PARTS_PENDING`/`COMPLETE`).
**Extend by** making status a **tenant-configurable lightweight workflow** —
built-in defaults (the current enum values) plus tenant-added statuses, using
the same enum→configurable-reference conversion as §2, with a terminal-state
flag so the existing terminal-rollup logic (a `Job` rolls up to `COMPLETED` when
all stops terminal) still holds. Keep it *lightweight*: named statuses +
optional ordering, **not** a rules/automation engine (§1 guardrails).
**Migration required** (enum → configurable statuses).

---

## 5. Proposed incremental build order

Small, independently-reviewable increments. **§1 lands first** — everything
else references its terminology/pack resolver and (for §7 grouping) the `Site`
entity. This is a **multi-increment build**; each increment is its own PR, and
the ones that touch the schema are flagged.

1. **§1a — Pack resolver (no migration).** Static `IndustryPackDefinition`
   registry + a service resolving "primary industry + enabled packs (from
   entitlements) → default terminology/bundle/dashboard ids." Pure code + tests,
   reuses `billing/plans.ts` shape. No DB change.
2. **§1b — Terminology map (migration).** `TerminologyOverride` table +
   read-time resolver + wire the frontend/DriverOS label layer. First migration.
3. **§1c — Default template pack + default dashboard (migration only if
   built-ins go global).** Seed the construction `ChecklistBundle` and the
   `isDefault` `DashboardLayoutPreset`; extend the `companyId`-nullable built-in
   pattern to these tables if defaults are shipped globally.
4. **§7 — `Site` entity (migration).** New `Site` table + nullable
   `siteId` FKs on `Asset`/`MaintenanceJob`/`ComplianceDocument`/`Job`.
   Gate the pack surface with `@RequireFeature('pack_construction')`.
5. **§2 — Configurable compliance document types (migration).** Enum →
   tenant-configurable reference; keep the expiry-sweep untouched.
6. **§4 — Construction templates (seed only).** Author the prestart/SWMS/
   inspection templates as bundle rows on the §1 engine. No schema change.
7. **§3 — Meter-reading capture + usage-based plans (migration).** Add
   engine-hours/odometer reading history + usage intervals on
   `AssetMaintenancePlan`; wire the trigger into the `MaintenanceJob` lifecycle.
8. **§5 — Repoint scan engine at Assets (migration likely).** Generalise the
   match target; add asset-scan endpoint; reuse `decodeScan`/config; DriverOS
   camera path unchanged in shape.
9. **§6 — Ad-hoc report builder (migration only if definitions persisted).**
   Generic group-by/filter over the existing `withTenant` grouped-SQL plumbing,
   as a platform capability, `Site` as a dimension.
10. **§8 — Configurable Job/Maintenance statuses (migration).** Enum →
    lightweight configurable workflow with terminal-state flags.

Every schema-touching increment respects the code-size/complexity limits of
ADR 0001 (500 lines/file, 50 lines/function) and the "one clean migration per
structural change" discipline the existing migrations follow.
