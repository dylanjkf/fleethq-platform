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
| 1b | Bootstrap script (first Super Admin) | Pending |
| 2 | Organisation + customer-user administration | Pending |
| 3 | Executive dashboard (real aggregate data) | Pending |
| 4 | Billing operations on top of the existing Stripe integration | Pending |
| 5 | Support tools, feature flags, system health, cross-tenant fleet views | Pending |
| 6 | Admin frontend SPA | Pending |
| 7 | Audit-log wiring across every phase, hardening, docs, tests | Pending |

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

## Not yet built

Nothing past Phase 1 exists yet: no organisation/customer-user
administration, no dashboard, no billing operations, no support tools, no
feature flags, no admin frontend. `admin_permissions`/`admin_roles` rows and
the first real `AdminUser` also don't exist yet outside test fixtures — that
bootstrap step is Phase 1b, tracked separately.
