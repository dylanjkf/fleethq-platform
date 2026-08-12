# ADR 0002 — Industry packs & combined accounts (multi-vertical architecture)

Status: Accepted
Date: 2026-08-12
Deciders: Engineering (Construction & Warehouse vertical build, Part 2)
Supersedes/relates to: uses the existing Stripe entitlements system (`billing/plans.ts`,
`@RequireFeature`/`FeatureGuard`) and the RLS multi-tenant boundary.

## Context

FleetHQ is expanding from a single Transport & Logistics product into multiple
industry verticals — Construction & Civil (Part 1) and Warehouse Operations
(Part 3). A single ownership group may operate more than one of these at once
(e.g. a civil contractor that also runs a yard/warehouse, or a transport company
that also owns plant). We must decide **how a tenant carries multiple verticals**
before building either vertical out, because it determines how every vertical
stores and gates its data.

The concrete question: when a company operates both transport and construction
(or warehouse), is that **one account with multiple modules enabled**, or **two
separate logins joined together**?

### What already exists (the primitives this decision must reuse)

- **RLS multi-tenancy.** Every tenant row carries `company_id`; all tenant work
  runs inside `PrismaService.withTenant(companyId, …)` with the RLS GUC pre-set.
  This boundary has been hardened across multiple audit rounds (GPS RLS,
  cross-tenant exposure fixes, `assertOwnership` consolidation). It is the thing
  the product's isolation guarantees are actually built on.
- **Stripe-backed entitlements + feature paywall.** `billing/plans.ts` defines
  `FeatureKey = 'core' | 'forms' | 'intelligence' | 'warehouse'`; plan tiers list
  the features they include; `EntitlementsService` resolves a company's live
  feature set from its Stripe subscription/trial. `@RequireFeature(feature)`
  (`common/decorators/require-feature.decorator.ts`) + `FeatureGuard`
  (`common/guards/feature.guard.ts`) enforce the paywall **server-side on every
  request**, independent of `@RequirePermission` (features = "has the company
  paid for this capability"; permissions = "is this user allowed to do it").
  Note `'warehouse'` is *already* a feature key gating `warehouse.controller.ts`.
- **`Company.industry`** (`schema.prisma:235`) is a nullable **free-text String**
  today — a label, with no behaviour attached and no enum.
- **~140-key granular RBAC**, the **versioned JSON-schema checklist/form engine**,
  the **scan-matching engine**, the **integration-connector framework**, and the
  **admin-toggleable feature-flags module** (`feature-flags/`, distinct from plan
  entitlements — runtime ops flags, not billing).

## Decision

**One `Company`/tenant can have multiple industry packs enabled simultaneously,
as entitlement feature keys on the existing Stripe entitlements system.** One
login, one RLS tenant boundary, one combined asset register and reporting view,
sectioned/filtered by pack where useful.

Concretely:

1. **Packs are entitlement `FeatureKey`s.** Add pack keys to the existing
   `FeatureKey` union — `pack_transport`, `pack_construction`, `pack_warehouse`
   (names finalised in the Part 4 billing wiring) — and gate pack-specific
   endpoints with the **existing** `@RequireFeature(...)` / `FeatureGuard`. No new
   gating mechanism. Each pack is a **separately-billed Stripe entitlement**
   (Part 4). `core` stays the always-on base; `forms`/`intelligence` stay
   capability features orthogonal to packs.
2. **`Company.industry` becomes the *default/primary* pack + terminology/dashboard
   driver (Part 1 §1), not the access control.** A company can have a primary
   industry (drives default terminology, template pack, landing dashboard) while
   having *additional* packs entitled. Access is always the entitlement set, never
   the `industry` string. (We keep `industry` as the free-text/primary label and
   add a resolved "enabled packs" list derived from entitlements.)
3. **Data stays in one tenant, one asset register.** Construction plant and
   warehouse stock are rows under the same `company_id`, distinguished by their
   own entity types / a pack discriminator where a shared entity serves two packs
   — *not* by a second tenant. Combined reporting is therefore a normal
   within-tenant query; pack sectioning is a filter, not a join across tenants.
4. **UI is pack-aware, not pack-forked.** The frontend and DriverOS render
   navigation/landing/branding from the active pack(s) (Part 1 §1 dashboards,
   Part 3 "Warehouse mode"), reusing the one web app and the one DriverOS shell.

## Alternatives considered

### A. (CHOSEN) One tenant, multiple packs as entitlement flags
- **Pros:** reuses the entitlements + `@RequireFeature` paywall verbatim (Part 4
  becomes "add Stripe prices + feature keys", not new infrastructure); no change
  to the RLS boundary; combined asset register/reporting is free (same tenant);
  a company adding a second vertical is a billing change, not a migration; one
  login, one audit trail, one permission model.
- **Cons:** a company that genuinely wants two *data-isolated* businesses under
  one owner can't get that here (they'd be two tenants regardless). Pack data
  co-mingles in one tenant, so "show only construction" is a query filter we must
  apply consistently (mitigated: it's a filter, not a security boundary — RLS
  already isolates the *company*, and RBAC already isolates *users*).

### B. (REJECTED for the default case) Two separate tenant accounts + account-linking/SSO
A transport tenant and a construction tenant under the same ownership group, kept
data-isolated from each other, joined by an account-linking/SSO layer so one human
logs in once and switches between them.
- **Why rejected as the default:** it is a materially larger and riskier build that
  the stated use case does not require. It needs (a) a **new cross-tenant session
  model** — a session that can act against more than one `company_id`, which is
  exactly the invariant ("a session is scoped to one company") that the RLS
  hardening and `withTenant`/JWT `companyId` design depend on; (b) a **new
  account-linking data model** and its own authz; (c) **new attack surface on the
  multi-tenant boundary** this codebase has spent multiple audit rounds hardening —
  every place that assumes "one session ⇒ one tenant" becomes a potential
  cross-tenant leak. The benefit it buys (hard data isolation *between* a single
  owner's two businesses) is a niche requirement, and when it *is* real it's
  already served by simply having two separate accounts with two logins — the
  linking/SSO convenience is the only delta, and it is not worth reopening the
  tenant-isolation boundary for.
- **When B would be revisited:** only if a concrete customer needs two businesses
  that must stay mutually data-isolated *and* demands a single sign-on across them.
  If that arises it is a separately-scoped project with its own threat model and
  audit, **not** folded into this build. Per Part 2, building B silently would
  change the shape of everything else in this brief, so it is explicitly out.

## Consequences

- **Part 1 (construction)** stores its entities under the same tenant and gates
  its paid surface with `@RequireFeature('pack_construction')`. Industry
  terminology/templates/dashboard are driven by the primary `industry` + enabled
  packs (Part 1 §1), resolved from entitlements.
- **Part 3 (warehouse)** does the same with `@RequireFeature('pack_warehouse')`
  (building on the already-present `'warehouse'` feature — we reconcile the two so
  there is one warehouse entitlement, not two). Warehouse stock/bins are rows in
  the same tenant.
- **Part 4 (billing)** = add Stripe prices + the pack feature keys to the tier/
  add-on mapping; no new gating code.
- **Part 5 (security)** benefits: no new tenant-boundary surface to audit; the
  existing RLS + RBAC + audit trail cover the new data by construction, and the
  hardening work is "confirm the new actions/endpoints are captured/throttled/
  encrypted", not "audit a new isolation model".
- **Risk to manage:** pack co-mingling means combined views must filter by pack
  consistently; we treat pack as a presentation/scoping filter and never as the
  security boundary (RLS/RBAC remain the boundary). A shared entity that serves two
  packs (e.g. an Asset that is both a delivery vehicle and construction plant)
  carries a pack tag/relationship rather than being duplicated per pack.

## Follow-ups this ADR unblocks
- Part 1 §1: resolve enabled packs from entitlements; drive terminology/templates/
  dashboard from primary industry + packs.
- Part 4: reconcile the pre-existing `'warehouse'` feature key with the new
  `pack_warehouse` entitlement so there is exactly one warehouse paywall.
