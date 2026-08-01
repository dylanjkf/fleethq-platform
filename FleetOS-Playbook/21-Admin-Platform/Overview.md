# FleetHQ Internal Administration Platform

The FleetHQ Administration Platform is FleetHQ staff's own tool for operating,
monitoring, and supporting the SaaS business — organisations, billing, support,
system health, and FleetHQ staff accounts themselves. It is a completely
separate system from the customer-facing product (`fleethq-frontend` /
`fleethq-platform/api`'s customer routes): separate authentication, separate
database role, separate token space, separate frontend. No customer account
can ever become an administrator, and no admin credential can ever be used
against a customer-facing route, by construction rather than by a runtime
check that could be buggy or bypassed.

This document tracks what's actually built, phase by phase, so it never
drifts into aspirational documentation describing features that don't exist
yet.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Schema, auth (login/MFA/sessions/lockout), permission-guarded route foundation | **Done** |
| 1b | Bootstrap script (first Super Admin) | **Done** |
| 2 | Organisation + customer-user administration | **Done** |
| 3 | Executive dashboard (real aggregate data) | **Done** |
| 4 | Billing operations on top of the existing Stripe integration | **Done** |
| 5 | Support tools, feature flags, system health, cross-tenant fleet views | **Done** |
| 6 | Admin frontend SPA (`admin/`) | **Done** |
| 7 | Audit-log wiring across every phase, hardening, docs, tests | **Done** |
| 8 | Repo split: `admin/` → `fleethq-frontend`, `driveros/` → `fleethq-driveros` | **Done** |

## Isolation model

Three separate database roles now exist on the `fleetos` database:

- `fleetos_app` — the customer API's runtime role. RLS-constrained; can only
  see one tenant's rows per request (`app.current_company_id`).
- `fleetos_auth` — narrow, SELECT-only bypass on `users`/`companies`, used
  only for the pre-tenant-context username lookup at customer login.
- `fleetos_admin` — the admin platform's runtime role. `BYPASSRLS`, but with
  narrow, explicit `GRANT`s: full CRUD on the `admin_*` tables it owns, plus a
  short, specific list of read/write grants on customer tables needed for
  cross-tenant admin views (see the migration that creates the role for the
  exact grant list). Cross-tenant listing ("every organisation", "this
  admin's MRR dashboard") is fundamentally incompatible with per-request RLS
  — that incompatibility is why this role exists, not an oversight to "fix"
  with `withTenant` calls.

`AdminPrismaService` (`src/prisma/admin-prisma.service.ts`) is the only Prisma
client allowed to use `fleetos_admin`. It must never be reached from a
customer-facing controller, and `PrismaService`/`SystemPrismaService` must
never be used to serve an admin-platform request.

## Data model

Seven tables, all under `admin_*`, added in
`prisma/migrations/20260730092032_admin_platform_foundation/`:

- `admin_permissions` / `admin_roles` / `admin_role_permissions` — the admin
  permission catalog (`src/common/permissions/admin-permission-catalog.ts`)
  and named, editable role bundles. Two system role templates are intended
  (Super Admin, Support) but roles are just permission bundles, not a
  hardcoded enum — same philosophy as the customer Role model
  (`14-Security/Permissions_Model.md`).
- `admin_users` — a FleetHQ staff account. Created only via the bootstrap
  script (Phase 1b) or by an existing admin with `admin_users:manage` — there
  is no public admin-signup endpoint anywhere.
- `admin_sessions` — one row per active login (not per request); the JWT
  carries this row's id, and the row's `revokedAt`/`expiresAt` are checked on
  every request independent of the JWT's own signed expiry — this is what
  makes per-device session revocation actually work.
- `admin_trusted_devices` — "remember this device for 30 days", skipping the
  MFA challenge on a recognised device.
- `admin_login_attempts` — every login attempt, successful or not, including
  ones against a username that doesn't resolve to a real account.
- `admin_audit_logs` — every administrative action. `organisationId` is a
  plain indexed column, not a foreign key, so an audit row survives even if
  the organisation it describes is later hard-deleted.

`companies` also gained `suspendedAt`/`suspensionReason` columns, ready for
Phase 2's suspend/restore endpoints.

## Auth (Phase 1)

`src/admin-auth/` mirrors the customer `src/auth/` module's security
properties, adapted to FleetHQ staff accounts:

- **Passport strategy name `admin-jwt`** (`AdminJwtStrategy`), signed with
  `ADMIN_JWT_SECRET` — a completely different secret from the customer API's
  `JWT_SECRET`, so a token from one space can never be replayed against the
  other even under a guard misconfiguration. `env.validation.ts` fails the
  boot if the two secrets are ever equal.
- **Session-based revocation** — the JWT carries `sid` (session id) and `tv`
  (token version); `AdminJwtStrategy.validate()` re-checks both the account's
  live `tokenVersion` and the named session's `revokedAt`/`expiresAt` on every
  request.
- **TOTP MFA** (`AdminMfaService`) — reuses the customer platform's
  dependency-free `src/auth/mfa/totp.ts` directly (not duplicated), with its
  own enrolment/backup-code flow operating on `AdminUser`.
- **Trusted devices** — a SHA-256 hash of a client-supplied device id, valid
  30 days, skips the MFA challenge on a recognised device.
- **Brute-force lockout** — 5 failed attempts locks the account for 15
  minutes, mirroring the customer `AuthService`'s constants exactly.
- **Timing-safe login response** — a dummy bcrypt compare runs even when the
  account doesn't exist or is locked, so response timing can't be used to
  enumerate valid admin usernames.
- **Deny-by-default route classification** — every `/admin/v1` route must
  declare itself as exactly one of `@AdminAuthenticatedOnly()` (authenticated,
  deliberately permission-free) or `@RequireAdminPermission(...)` (gated on a
  role's granted permission). `AdminPermissionGuard` denies and audit-logs an
  unclassified route rather than allowing it through — the identical contract
  the customer API's `PermissionGuard` enforces, just for admin routes.
- **Layered guard chain, not global** — unlike the customer API's guards
  (`JwtAuthGuard`/`PermissionGuard`, wired globally via `APP_GUARD`), the
  admin guards (`AdminJwtAuthGuard`, `AdminPermissionGuard`) are applied
  per-route via `@UseGuards(...)`. Every admin controller is marked
  `@Public()` from the *customer* stack's perspective (satisfying
  `route-permission-coverage.spec.ts`, which requires every registered
  controller to carry a customer classification) while the real
  authentication/authorization for that route is enforced entirely
  independently by the admin guard chain.

### Endpoints (`/v1/admin/auth/*`)

| Route | Auth | Notes |
|---|---|---|
| `POST login` | none | Returns `{status: 'authenticated', accessToken, admin}` or `{status: 'mfa_required', mfaToken}` |
| `POST mfa/verify` | none (holds the short-lived `mfaToken`) | Completes an MFA-gated login |
| `GET me` | admin session | Identity + granted permission keys |
| `GET sessions` | admin session | This admin's active sessions |
| `DELETE sessions/:id` | admin session | Revoke one of the admin's own other sessions |
| `POST logout` | admin session | Revokes the current session |
| `POST mfa/setup` / `mfa/enable` / `mfa/disable` | admin session | TOTP enrolment |

### Env vars

`ADMIN_DATABASE_URL`, `ADMIN_JWT_SECRET`, `ADMIN_JWT_EXPIRES_IN` — see
`.env.example` for the full description of each; all three are required in
every environment (`env.validation.ts`), with production-strength checks on
`ADMIN_JWT_SECRET` mirroring `JWT_SECRET`'s.

### Tests

`test/admin-auth.e2e-spec.ts` covers: login, wrong password, lockout after 5
attempts, unauthenticated access to a protected route, a garbage bearer token,
the full MFA enrol → challenge → verify flow, session listing/revocation, and
logout — all against the real HTTP API and a live test database, the same
pattern the customer `auth.e2e-spec.ts` uses.

## Bootstrap (Phase 1b)

Two system-template `AdminRole`s ship, reconciled the same way the customer
platform's Administrator/Read Only roles are (`prisma/reconcile-admin-permissions.ts`,
called from `prisma/seed.ts`'s reference-data step and standalone via
`npm run admin:permissions:sync`):

- **Super Admin** — every permission in the catalog, always. New permissions
  added later are granted to it automatically.
- **Support** — a fixed, narrower subset (view organisations/billing, manage
  customer users and support tickets, view fleet/analytics/feature flags) —
  no billing changes, feature-flag edits, or staff management.

The first real `AdminUser` is created by `npm run admin:bootstrap`
(`scripts/bootstrap-admin.ts`) — the only way an admin account is ever
created without an existing admin doing it, since there is no public
admin-signup endpoint. It refuses to run if any `AdminUser` already exists
(bootstrap only, not a general admin-creation tool — an authenticated
endpoint for creating additional FleetHQ *staff* accounts, gated on
`admin_users:manage`, is still unbuilt; see "Not yet built" below). In
production every field (`ADMIN_BOOTSTRAP_USERNAME`/`_EMAIL`/`_FULL_NAME`/`_PASSWORD`)
is required and the password must pass the same strength policy
(`isStrongPassword`) as every other password in the codebase; outside
production it falls back to a documented dev-only default for convenience.
Doesn't enrol MFA itself (can't render a QR code from a CLI) — enable it
immediately after first login via `mfa/setup` + `mfa/enable`.

`scripts/rotate-db-role-passwords.ts` (run once per environment right after
first `prisma migrate deploy`, and again after any suspected leak) now
rotates `fleetos_admin` alongside `fleetos_app`/`fleetos_auth`, via
`NEW_ADMIN_ROLE_PASSWORD` — this closes a gap where the new role would
otherwise have shipped to production still on its migration's hardcoded
placeholder password.

## Organisations + customer users (Phase 2)

`src/admin-organisations/` and `src/admin-customer-users/` — cross-tenant
administration, all via `AdminPrismaService`/`fleetos_admin`, all
audit-logged.

**A real gap this phase closed first:** `suspendedAt` existed on `Company`
since Phase 1's schema, but nothing checked it — a "suspended" organisation
could still log in and use the product normally. Fixed in two places:
`AuthService.completeLogin`/`selectCompany` now exclude a suspended (or
archived) company's memberships from login, and `JwtStrategy.validate()`
now rejects a request against a suspended/archived company's `companyId`
even from an already-issued, not-yet-expired session token — the same
"takes effect on the very next request, not at next login" guarantee already
applied to `tokenVersion` revocation.

### Organisations (`/v1/admin/organisations/*`)

| Route | Notes |
|---|---|
| `GET /` | Paginated/searchable list, filterable by `status` (`active`/`suspended`/`archived`/`all`) |
| `GET /:id` | Detail: plan/trial/subscription status, asset/operator/attached-unit counts, active memberships with lockout/disabled state |
| `POST /:id/suspend` `{reason}` | Blocks all login/access immediately (see above); refuses if the org is archived |
| `POST /:id/restore` | Un-suspends |
| `POST /:id/archive` / `POST /:id/unarchive` | Soft delete / restore |
| `PATCH /:id/trial` `{trialEndsAt}` | Set/clear the native trial window (`null` clears it) |
| `POST /:id/impersonate` `{userId}` | Mints a real, 30-minute customer session token for that user, via `AuthService.issueSessionToken`'s `expiresIn` override — reuses the exact login signing path rather than a separate implementation. Refused for a suspended/archived org: impersonation is not a backdoor around suspension in this product's design |
| `POST /:id/users` | Support scenario: add a user on the customer's behalf (e.g. their only admin left) — same invite-without-password shape as the customer API's own user creation, but written directly via `fleetos_admin` so it lands in the admin audit log, not the tenant's own (a synthetic actor in the tenant's audit/timeline would misattribute who actually did this) |

### Customer users (`/v1/admin/customer-users/*`)

| Route | Notes |
|---|---|
| `GET /:userId` | Cross-tenant identity view — every active membership, across every organisation |
| `POST /:userId/disable` / `reactivate` | Archives/restores the account; disable takes effect on the account's very next request, same reasoning as organisation suspension |
| `POST /:userId/unlock` | Clears brute-force lockout |
| `POST /:userId/reset-mfa` | Clears TOTP secret/backup codes — for a user who's lost their authenticator |
| `POST /:userId/send-password-reset` | Delegates to the customer `AuthService.forgotPassword` — identical "silently no-ops without an email on file" behaviour as self-service; returns `{emailOnFile}` so the admin knows whether anything was actually sent |

### New shared pieces

- `AdminGuarded()` (`src/admin-auth/decorators/admin-guarded.decorator.ts`) — collapses the `AdminJwtAuthGuard` + `AdminPermissionGuard` pair every authenticated admin route needs into one decorator; `AdminAuthController` was retrofitted to use it too.
- `AdminActionContext` (`src/admin-auth/admin-action-context.interface.ts`) — the `{adminUserId, ip, userAgent}` shape threaded from every admin controller into its service, shared across feature modules rather than redeclared per-module.
- `test/admin-route-permission-coverage.spec.ts` — the admin-platform equivalent of `route-permission-coverage.spec.ts`: every `Admin*Controller` route must carry `@AdminAuthenticatedOnly()` or `@RequireAdminPermission()` (an explicit allowlist covers `login`/`mfa/verify`, the only two genuinely unauthenticated ones).

### Tests

`test/admin-organisations.e2e-spec.ts` and `test/admin-customer-users.e2e-spec.ts` — list/detail, suspend blocking a fresh login AND killing an already-issued session, archive/unarchive, trial updates, impersonation (including refusal against a suspended org), admin-created user login, disable/reactivate, lockout/unlock, MFA reset, and password-reset triggering — all against the real HTTP API and a live test database.

## Executive dashboard (Phase 3)

`src/admin-analytics/` (`/v1/admin/analytics/*`, gated on `analytics:view`)
— real aggregate business data, computed on every request (no caching, no
scheduled rollups) from the same `fleetos_admin` connection every other
admin module uses. Deliberately reports **only** metrics this codebase can
actually produce — no fabricated infrastructure numbers (queue depth, cache
hit rate, etc.) for systems that don't exist here. See "Not yet built" for
what real system/infra health looks like instead (Phase 5).

| Route | Returns |
|---|---|
| `GET overview` | Organisation counts (active/suspended/archived/total), active-trial count, user counts (total + new in last 30 days), fleet totals (assets/operators), subscription-status breakdown, a churn count, and revenue |
| `GET signups?days=N` (default 30, max 365) | Daily company-creation counts over the trailing window |
| `GET trials-expiring?days=N` (default 7, max 365) | Organisations whose native trial ends within the window — an actionable follow-up list (id, name, trial end, suspended state, user count), not just a count |

**Revenue (MRR/ARR)**: computed from the small, fixed set of configured tier
price ids (`PAID_TIERS` in `src/billing/plans.ts`) — at most 3 Stripe API
calls total (`BillingService.getPriceUnitAmounts`, a new stateless,
tenant-independent method added to the existing customer `BillingService`),
never one lookup per subscribed company. Annual prices are normalised to a
monthly figure before summing. Honestly reports `billingConfigured: false`
(with `mrr`/`arr`/`currency` all `null`) rather than fabricating a number
when no `STRIPE_SECRET_KEY` is set — the same tolerance `BillingService`
already has everywhere else. `revenue.byTier` breaks the total down per
tier so it's auditable, not a black box.

**Churn**: `Company` has no `cancelledAt` column, so this is a documented
best-effort proxy — a count of currently-`CANCELED` companies whose
`updatedAt` falls in the last 30 days (the billing webhook touches both
fields together on a status transition). Reported as a plain count, not a
percentage — a true churn *rate* would need a historical
active-customer-count this schema doesn't track, and presenting one anyway
would overclaim precision the data doesn't support.

No new database grants were needed — `fleetos_admin`'s existing read access
to `companies`/`users`/`assets`/`operators` (from Phase 1's migration)
already covers everything this phase's spec called for.

### Tests

`src/admin-analytics/admin-analytics.service.spec.ts` — unit coverage for
the MRR arithmetic specifically (monthly/annual normalisation, multi-tier
summation, a failed price lookup excluded from the total but still listed),
with `BillingService`/`ConfigService`/`AdminPrismaService` mocked — the
configured-Stripe path can't be exercised end-to-end without real network
access to Stripe. `test/admin-analytics.e2e-spec.ts` covers the real
HTTP API path: auth rejection, real aggregate counts, the
`billingConfigured: false` path (no Stripe key in this test environment),
the signups time series, trials-expiring, and query validation.

## Billing operations (Phase 4)

`src/admin-billing/` (`/v1/admin/organisations/:companyId/billing/*`, nested
under organisations to match the Phase 2 company-scoped-action convention) —
FleetHQ staff billing operations layered directly on the existing customer
Stripe integration (`BillingService`), not a second Stripe SDK instance or a
separate billing data model.

**"Stripe is the source of truth" holds for admin writes too.** Every method
in `AdminBillingService` only ever reads/acts on Stripe objects and the two
Stripe id columns on `Company` (`stripeCustomerId`/`stripeSubscriptionId`).
`Company.subscriptionStatus`/`planPriceId` remain exclusively
`BillingService.handleWebhookEvent`'s responsibility — an admin refunding an
invoice or cancelling a subscription changes Stripe's state, and the next
webhook delivery is what reflects that back onto the `Company` row, exactly
as it would for a customer-initiated change. No admin billing method writes
those two columns directly.

| Route | Permission | Notes |
|---|---|---|
| `GET /` | `billing:view` | Status: DB subscription status/plan/trial plus, if a live subscription exists and Stripe is configured, a real-time Stripe read (status, `cancelAtPeriodEnd`, current period end, active discounts) |
| `GET /invoices` | `billing:view` | Stripe's own cursor-paginated invoice list for this company's customer |
| `POST /refund` `{invoiceId, amountCents?, reason?}` | `billing:manage` | Full or partial refund; resolves the invoice's payment reference itself (see below) |
| `POST /coupon` `{couponId}` | `billing:manage` | Applies an existing Stripe coupon (created in the Stripe Dashboard/API — this platform doesn't create coupons) to the subscription via `discounts: [{coupon}]`, the current (non-deprecated) Stripe API shape |
| `POST /manual-invoice` `{description, amountCents, currency?}` | `billing:manage` | Ad hoc one-off charge — an invoice item plus a `send_invoice` (not auto-charged) invoice, finalized immediately. For charges outside the normal subscription cycle, not for changing what the subscription itself bills |
| `POST /credit-note` `{invoiceId, amountCents, reason?}` | `billing:manage` | Stripe requires an explicit amount — no implicit "full remaining balance" |
| `POST /retry-payment` `{invoiceId}` | `billing:manage` | `stripe.invoices.pay(...)` |
| `POST /cancel` `{atPeriodEnd?}` | `billing:manage` | `atPeriodEnd: true` sets `cancel_at_period_end`; omitted/false cancels immediately |
| `POST /reinstate` | `billing:manage` | Undoes a pending `cancel_at_period_end`. Refuses (409) if the subscription has already fully transitioned to `canceled` — Stripe can't resume a fully-canceled subscription, only unset the flag before that happens, so this errors clearly instead of silently no-op-ing |

**Cross-tenant safety on invoice-scoped actions:** refund/credit-note/
retry-payment all resolve the invoice via Stripe first, then verify its
`customer` matches the target company's `stripeCustomerId` before acting —
the route only scopes by `companyId` in the URL, so without this check an
admin permitted to act on Company A could pass an arbitrary invoice id
belonging to Company B.

**Refund payment-reference resolution:** this Stripe SDK version (22.3.2)
moved `payment_intent` off `Invoice` itself onto the invoice's `payments`
list (`Stripe.InvoicePayment[]`, each wrapping either a `payment_intent` or
an out-of-band `charge`) — a real API-shape difference verified directly
against the vendored `.d.ts` files rather than assumed from older Stripe
documentation. `AdminBillingService.resolvePaymentReference` reads the
invoice's paid (or default) `InvoicePayment` entry to find the id a refund
actually needs.

**Every mutation is audit-logged** (`BILLING_REFUND_ISSUED`,
`BILLING_COUPON_APPLIED`, `BILLING_MANUAL_INVOICE_CREATED`,
`BILLING_CREDIT_NOTE_ISSUED`, `BILLING_PAYMENT_RETRIED`,
`BILLING_SUBSCRIPTION_CANCELED`, `BILLING_SUBSCRIPTION_REINSTATED`), and
every unconfigured/missing-Stripe-object case fails with a specific error
code (`NO_STRIPE_CUSTOMER`, `NO_STRIPE_SUBSCRIPTION`,
`BILLING_NOT_CONFIGURED`, `INVOICE_NOT_FOUND`, `INVOICE_NOT_PAID`,
`SUBSCRIPTION_ALREADY_CANCELED`, `SUBSCRIPTION_NOT_PENDING_CANCELLATION`)
rather than a generic 500 or a silent no-op.

### Tests

`test/admin-billing.e2e-spec.ts` — auth rejection, `billing:view`-only admin
rejected from a `billing:manage` route, 404 for a non-existent organisation,
DTO validation, and the `NO_STRIPE_CUSTOMER`/`NO_STRIPE_SUBSCRIPTION` refusal
path for every mutating route against a fresh tenant with no Stripe objects
yet. Exercising a real Stripe API call (an actual refund, coupon application,
or invoice creation against a live customer) needs a live Stripe test
account this offline suite doesn't have — the same documented constraint
`test/billing.e2e-spec.ts` already carries for the customer-facing
checkout/portal-session tests.

## Support tools, feature flags, system health, fleet views (Phase 5)

Four independent slices, each its own module, none touching another's tables.

### Support tools (5a)

`src/admin-support/` (`support:view`/`support:manage`):

| Route | Notes |
|---|---|
| `GET/POST/PATCH/DELETE /v1/admin/announcements` | A staff-authored banner. Unlike every other admin-platform table, `Announcement` is deliberately NOT `admin_`-prefixed and NOT row-level-secured — it's meant to be read by the customer stack (`fleetos_app` gets a plain read-only `GRANT SELECT`, since every row is shown to every company, so there's no tenant data to leak). `startsAt`/`endsAt` null means "starts immediately"/"never expires" |
| `GET/POST/DELETE /v1/admin/organisations/:id/notes` | Staff-internal notes about an organisation (support history, escalation flags) — `admin_organisation_notes`, `admin_`-prefixed and never granted to `fleetos_app`: unlike announcements, a customer must never read these |
| `POST /v1/admin/customer-users/:userId/resend-verification` | Delegates to the customer `AuthService.resendVerification` — same no-op-if-already-verified-or-no-email behaviour as self-service. Lives on `AdminCustomerUsersController` (Phase 2) rather than a new controller, gated on `support:manage` per the permission catalog's own description |

New customer-facing route: `GET /v1/announcements/active` (`src/announcements/`, `@AuthenticatedOnly()`) — every user of any role sees the same window-filtered, active-only list.

### Feature flags (5b)

Not a scaffold: `operational-recommendations`'s two routes are gated on a real flag (`RequireFeatureFlag('operational_recommendations')`), so this section proves the mechanism actually blocks a request, not just that it stores rows.

- `FeatureFlag` (global, no RLS, `fleetos_app` read-only — same pattern as `Announcement`) holds `globalEnabled`, the default for every company with no override.
- `FeatureFlagOverride` (has `companyId`, gets the identical `tenant_isolation` RLS policy every other tenant table has) narrows that per company.
- `src/feature-flags/` (customer side): `FeatureFlagsService.isEnabled(key, companyId)` — a flag key that doesn't exist yet **fails open** (enabled), so creating a flag is always a safe, additive admin action, never a surprise outage. `GET /v1/feature-flags` (`@AuthenticatedOnly()`) returns the evaluated map for a client to consult once per session.
- `FeatureFlagGuard`/`@RequireFeatureFlag(key)` (`src/common/guards/feature-flag.guard.ts`) — registered globally via `APP_GUARD`, a no-op unless a route declares a required flag, modelled directly on the existing `FeatureGuard`/`@RequireFeature` billing-entitlement guard but answering a different question ("has FleetHQ staff turned this on for this company right now" vs. "has this company paid for this"). Rejects with `403 FEATURE_DISABLED`, not the entitlement guard's `402`.
- `src/admin-feature-flags/` (`feature_flags:view`/`manage`): `/v1/admin/feature-flags` (CRUD on flag definitions) and `/v1/admin/organisations/:id/feature-flags` (list every flag's effective state for that org; `PUT`/`DELETE .../feature-flags/:flagKey` sets/clears that org's override).

### System health (5c)

`src/admin-system/` (`system:view`), `GET /v1/admin/system/health` — reports only what this deployment can actually answer: `SELECT 1` reachability on both the customer (`fleetos_app`) and admin (`fleetos_admin`) database roles, process uptime, Node version, the API's own `package.json` version, and a deployed commit SHA if the platform injects one (`GIT_COMMIT_SHA`/`RAILWAY_GIT_COMMIT_SHA`, `null` otherwise). No fabricated infrastructure numbers (queue depth, cache hit rate, CPU/memory graphs) for systems that don't exist here — the same honesty standard `AdminAnalyticsService`'s revenue reporting established in Phase 3.

### Cross-tenant fleet views (5d)

`src/admin-fleet/` (`fleet:view`), read-only: `GET /v1/admin/fleet/assets|operators|integrations` — the support scenario is "which organisation owns this asset/VIN/rego" or "which company is this GPS integration configured for" without an admin already knowing the `companyId`. Reuses Phase 1's existing `fleetos_admin` read grants on `assets`/`operators`; a new migration grants read access to `integration_connections` **only** — never `integration_credentials` (holds encrypted secrets: payload/IV/tag), and the customer's live operator location (`lastLat`/`lastLng`/`lastLocationAt` — personal information under the Privacy Act) is deliberately excluded from the response with no support-lookup justification for a cross-tenant view to see it.

### Tests

`test/admin-support.e2e-spec.ts`, `test/admin-feature-flags.e2e-spec.ts`, `test/admin-system.e2e-spec.ts`, `test/admin-fleet.e2e-spec.ts` — 22 tests total, all against the real HTTP API and a live test database, including the feature-flag suite's proof that disabling `operational_recommendations` actually returns `403` and a per-company override actually restores access.

### Audit log browse endpoint (Phase 6 prereq)

`AdminAuditService.list()` / `GET /v1/admin/audit-log` (`audit_log:view`) —
every mutating admin action writes to `admin_audit_logs` (a handful of gaps
in `admin-auth` were closed in Phase 7, below); this is the first endpoint
that *reads* it back, paginated and filterable by
`action`/`entityType`/`organisationId`/`adminUserId`/`from`/`to`.
Needed before the frontend could have a real Audit Log page rather than a
placeholder. `test/admin-audit-log.e2e-spec.ts`: auth/permission rejection
and a positive test that creates an announcement, then finds its
`support.announcement_created` entry via the `action` filter.

Also added this phase: `GET /v1/admin/organisations/:id/roles` (id + name
only) — so the existing "add a user to this org" support action
(Phase 2) can offer a real role picker instead of requiring the admin to
paste a raw role UUID. No new database grants needed (`fleetos_admin`
already had `SELECT` on `roles` from Phase 1).

## Admin frontend SPA (Phase 6)

> **Relocated in Phase 8**: `admin/` was originally built as a sibling
> directory in *this* repo (`fleethq-platform`), for the reasons the next
> paragraph explains. It has since moved into the
> [`fleethq-frontend`](https://github.com/dylanjkf/fleethq-frontend) repo as
> a sibling app there instead, deployed at `fleethq.online/admin` — see that
> repo's `admin/README.md`. Everything below describes the app itself
> (still accurate); only its repo location has changed.

`admin/` — a new, independently built/deployed React app. Originally built
as a sibling to `api/` and `driveros/` in this repo (see the root README's
historical layout at the time) rather than inside `fleethq-frontend`,
because that customer SPA lived in a separate, unattached repo from that
session's perspective, and because a completely separate deployable was the
correct shape regardless: separate origin, separate auth, separate bundle,
no accidental code sharing between "FleetHQ staff tool" and "customer
product" that Phase 1's backend isolation already went out of its way to
avoid. That isolation (separate `package.json`/build/auth) is preserved in
its new location too — see Phase 8 below.

**Stack**: React 19 + Vite + TypeScript + Tailwind CSS 4, TanStack Query,
`react-router`, `axios` — the same versions `driveros` already uses, minus
everything offline/native-specific (`idb`, Capacitor, the PWA service worker)
since this is a desktop-only internal console with no offline requirement.
`oxlint` for linting, matching the rest of the repo; its per-function
line/complexity thresholds are raised from `driveros`' mobile-screen defaults
(50 lines / complexity 10 → 240 / 18, documented inline in `.oxlintrc.json`)
because admin console pages (tabbed detail views, multi-form ops panels) are
legitimately longer than a single mobile field screen.

**Auth**: two-step login (`username`/`password` → either an immediate
session or an `mfaToken` requiring a TOTP code), a `crypto.randomUUID()`
device fingerprint persisted in `localStorage` for the backend's trusted-
device skip-MFA behaviour, and an `AuthContext`/`useAuth()` exposing
`hasPermission(key)` off `GET /v1/admin/auth/me`'s granted permission list —
every nav item, tab, and action button in the app is gated on the same
permission key the backend route actually enforces, so the UI's visible
surface can never drift ahead of what a click would actually be allowed to
do.

**Pages**, one per admin backend module built in Phases 1–5 plus the Phase 6
prereq above: Dashboard (Phase 3's aggregate/revenue/signups/trials data),
Organisations list + detail (Overview/Billing/Notes/Feature Flags tabs —
suspend/restore/archive/trial edit/impersonate/add-user on Overview, the
full Phase 4 billing action set on Billing, notes CRUD, per-org flag
overrides), Customer User detail (disable/reactivate/unlock/reset-MFA/
password-reset/resend-verification), Announcements (create/activate/
deactivate/delete), Feature Flags (global CRUD), System Health (30s
auto-refreshing DB/process/version diagnostics), Fleet (cross-tenant
assets/operators/integrations search, three tabs), Audit Log (filterable,
paginated), and Settings (MFA enrol/disable, active-session list/revoke).

**Every "no data" and "not configured" state is honest, not a placeholder**:
a fresh Feature Flags page explicitly states "a gated route treats a missing
flag as enabled, so this is always safe" (matching `FeatureFlagsService`'s
actual fail-open behaviour); the Dashboard's revenue card shows "Billing is
not configured on this deployment" rather than a fabricated `$0`, mirroring
`AdminAnalyticsService`'s own `billingConfigured: false` honesty from Phase 3.

**Impersonation UX is a deliberate scope decision, not a gap**: the
Overview tab's impersonate action shows the minted customer access token in
a `ConfirmDialog` for the admin to copy manually rather than a same-tab
handoff into the office-dashboard app. This was necessary when `admin/` and
`fleethq-frontend` were separate, unattached repos; now that both live in
the same repo/origin (Phase 8) a real handoff is possible but still not
built — see that repo's `admin/README.md` "Known scope decisions".

**Cross-tenant safety carried into the UI**: the Fleet page's tables never
render `config`/`credentialId` (verified absent from the `FleetIntegration`
type the API client exposes), and neither the Customer User detail page nor
an organisation's Overview tab render operator live location — matching the
backend's own Privacy-Act-driven exclusions from Phase 5d.

### Verification

`npx tsc -b`, `npx oxlint`, and `npm run build` all clean. Manually
browser-tested end to end against a live local API + Postgres with
Playwright: full login (no MFA enrolled on the test account, so the direct-
session path), every page above rendered with real data (thousands of real
seeded/test organisations, assets, and audit-log rows from the backend test
suite), a full write-path round trip (create → list → delete an
announcement, confirmed via a fresh fetch each time), and organisation-detail
navigation from the list. No console errors or failed requests during the
run.

## Audit wiring, hardening, tests, docs (Phase 7)

Closed the gaps a systematic audit of every admin-\* service/controller
found, rather than a rebuild — Phases 1-6 already audit-logged the large
majority of mutations correctly.

**Audit logging gaps, all in `admin-auth`** (every other admin module was
already complete): MFA enrolment (`MFA_ENABLED`) and disablement
(`MFA_DISABLED`) were silent; a backup code being consumed during either a
login MFA challenge or a disable-MFA challenge went unlogged
(`MFA_BACKUP_CODE_USED` — a real signal an admin's authenticator may be
lost/compromised); `logout()` revoked the session without a trail, unlike
the near-identical `revokeOwnSession()` right above it in the same file
(`LOGOUT`); and "remember this device" silently extended a 30-day MFA-skip
window with no record (`DEVICE_TRUSTED`). Five new `ADMIN_AUDIT_ACTIONS`,
wired at the point each event actually completes.

**Permission-guard coverage test had a blind spot.**
`test/admin-route-permission-coverage.spec.ts` dynamically scans every
`Admin*Controller` for the `@AdminAuthenticatedOnly()`/
`@RequireAdminPermission()` classification decorator — but never checked
that `AdminJwtAuthGuard`/`AdminPermissionGuard` (wired per-route via
`@AdminGuarded()`, not globally — every admin controller is `@Public()` from
the *customer* stack's perspective) were actually present on the route. A
future route carrying the classification decorator but missing
`@AdminGuarded()` would have passed this test while being completely
unauthenticated in production. Now asserts `Reflect.getMetadata(GUARDS_METADATA, ...)`
includes both guard classes on every non-exempt route.

**Rate limiting on high-value mutations.** Only `admin-auth`'s own
credential/code-checking routes were tightly throttled; every other admin
mutation — including Stripe billing actions and customer-account
impersonation/MFA-reset/unlock — fell back to the app-wide 300/min default,
far too loose for actions with real financial or account-takeover blast
radius. New `ADMIN_SENSITIVE_ACTION_THROTTLE` (20/min, `src/common/throttles.ts`,
alongside the existing `BULK_THROTTLE`/`EXPORT_THROTTLE`/etc. presets) now
gates all seven `AdminBillingController` mutations, organisation
impersonation, and customer-user `unlock`/`reset-mfa`.

**Test coverage**: `test/admin-auth.e2e-spec.ts` gained an `mfa/disable`
positive-and-negative-code test and a test proving the five new events above
land in the audit log (queried back through `GET /v1/admin/audit-log`, the
same endpoint the frontend uses — not a raw DB check). New
`src/admin-billing/admin-billing.service.spec.ts` (11 tests, Stripe client
mocked): every one of the seven mutating billing methods' happy path, the
cross-tenant invoice-ownership rejection, and both reinstate-subscription
refusal branches — the e2e suite could only cover the "no Stripe
customer/subscription yet" refusal paths, since a completed refund/coupon/
invoice/credit-note/retry needs a live Stripe test account this offline
suite doesn't have.

**Not done in this phase, deliberately out of scope**: CSRF protection —
inapplicable by construction (bearer token in the `Authorization` header via
`admin/`'s `tokenStore`, never a cookie, so there's no ambient credential a
cross-site request could ride on). CORS: `CORS_ALLOWED_ORIGINS` already
supports an arbitrary allowlist (`main.ts`); a deployed `admin/`'s origin
needs adding to that env var — as of Phase 8 (below) that's the same origin
`fleethq-frontend` already needs, so it's one entry, not two.

## Repo relocation: driveros/ and admin/ move out (Phase 8)

Two of this repo's three original apps moved to their own repos, on
explicit request, once it became clear each needed a repo boundary this one
repo didn't give it:

- **`admin/` → `fleethq-frontend`** (as a sibling app, `fleethq-frontend/admin/`,
  deployed at `fleethq.online/admin` via that repo's `vercel.json` — one
  Vercel build produces both apps' output, with `/admin/(.*)` routed to
  `admin`'s own `index.html` ahead of the office-dashboard's catch-all SPA
  rewrite). The two apps still share nothing but the repo and the deploy
  domain: separate `package.json`, separate build, separate bundle, and —
  unchanged — completely separate authentication from the customer app.
  `vite.config.ts` gained `base: '/admin/'` and `router.tsx` passes
  `basename: import.meta.env.BASE_URL` to `createBrowserRouter` so
  client-side routing agrees with the subpath in both dev and production.
- **`driveros/` → its own repo**, [`fleethq-driveros`](https://github.com/dylanjkf/fleethq-driveros),
  content moved as-is (no functional changes, lint/build/test re-verified
  clean in the new location) — so native iOS/Android App Store / Google
  Play release tooling and CI can live on their own cadence, independent of
  this API's.

**What did not move**: the admin platform's *backend* — `api/src/admin-*`,
the `admin_*` database tables, and the `fleetos_admin` role — is unchanged
and still lives entirely in this repo. Only the two frontend clients moved;
this repo remains the single source of truth for every admin permission,
audit event, and guard.

**Not verified against a live deployment**: the `fleethq-frontend`
multi-app Vercel build command was verified locally (both apps build, the
admin build's assets resolve under `/admin/assets/*`) but not against a
real Vercel build/CDN — see that repo's README for the "spot-check after
first deploy" note.

## Not yet built

FleetHQ staff account management (`admin_users:view`/`manage` — creating
admins other than via the one-time bootstrap script) — see the status table
above.
