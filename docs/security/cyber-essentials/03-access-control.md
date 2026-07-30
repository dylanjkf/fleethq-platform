# Access control & user management

## Intent

FleetOS is a multi-tenant SaaS: many independent fleet operators share one
database and one API. Access control therefore has to do two jobs at once —
keep one company's data completely invisible to every other company, and, within
a company, ensure each person can only do what their role permits. This domain
covers the tenant-isolation boundary (PostgreSQL Row-Level Security), the
fine-grained role/permission model layered on top of it, the user lifecycle
(invite, role change, deactivation), and the safeguards and audit trail around
privileged administrative actions.

## What's implemented

### Database-enforced tenant isolation

**The API connects as a low-privilege role that cannot bypass RLS.** The single
database entry point binds `APP_DATABASE_URL`, which is the `fleetos_app` role —
not the schema owner and explicitly created without `BYPASSRLS`, so every query
it runs is subject to Row-Level Security. Tenant data is reached only through
`withTenant(companyId, …)`, which opens a transaction and sets the
`app.current_company_id` session GUC that every RLS policy reads. Isolation is
enforced by Postgres, not by application `where` clauses.
`apps/api/src/prisma/prisma.service.ts:22-30` (role binding),
`apps/api/src/prisma/prisma.service.ts:46-54` (`withTenant`).

**RLS is forced on every tenant table.** The foundational migration creates the
`fleetos_app` role, issues table-scoped grants (never blanket ones), and runs
`ALTER TABLE … FORCE ROW LEVEL SECURITY` on companies, memberships, roles,
role-permissions, assets, operators, timeline, and the rest — `FORCE` means even
a table owner is subject to the policy.
`apps/api/prisma/migrations/20260713063137_row_level_security/migration.sql:27-28`
(role creation, no `BYPASSRLS`), and the `FORCE ROW LEVEL SECURITY` /
`GRANT` stanzas through the same file.

**The cross-company `users` table has a purpose-built policy.** A `User` is a
login identity with no `company_id`, so it is scoped by relationship: a user row
is visible only if the requesting tenant shares an active `CompanyMembership`
with it. The policy is documented in-migration, including why `WITH CHECK (true)`
is correct for the create-then-link flow.
`apps/api/prisma/migrations/20260713080000_admin_entities_and_users_rls/migration.sql:25-43`.

**Least-privilege database roles.** Beyond `fleetos_app`, a second even narrower
role `fleetos_auth` exists solely for the pre-tenant username lookup at login: it
is `BYPASSRLS` but granted `SELECT` on `users` and nothing else — no writes, no
other table — so its entire blast radius is "read the users table".
`apps/api/prisma/migrations/20260713080000_admin_entities_and_users_rls/migration.sql:60-70`.

### Role-based access control

**Fine-grained, catalogued permissions.** Every action in the product maps to an
individually grantable `<resource>:<action>` permission (roughly one hundred of
them across assets, dispatch, users, roles, compliance, billing, privacy, audit,
and administration). The catalogue is the single source of truth; the keys are a
typed `const` object, so a mistyped permission is a compile error rather than a
silent always-false check. There is deliberately no `delete` capability anywhere
— destructive actions are `archive`, preserving history.
`apps/api/src/common/permissions/permission-catalog.ts:12-129` (keys),
`apps/api/src/common/permissions/permission-catalog.ts:139-251` (catalogue with
human descriptions).

**Permissions are resolved fresh from the database on every request.** The
`PermissionGuard` reads the caller's effective permissions for their active
membership from the database on each call — permissions are never cached and never
embedded in the JWT — so a permission grant or revocation takes effect on the very
next request without a re-login. The lookup itself runs inside `withTenant`, so
the guard cannot see roles from another tenant.
`apps/api/src/common/guards/permission.guard.ts:24-59`.

**Denied access is recorded as a security signal.** A failed permission check
emits a structured `access.permission_denied` log line (user, company, membership,
required permission, path) and returns a `403 FORBIDDEN`, distinct from the
business-history Timeline.
`apps/api/src/common/guards/permission.guard.ts:61-81`.

### Administrative safety and user lifecycle

**Last-admin lockout protection.** A dedicated guard prevents any change that
would leave a company with no member able to manage users or roles. It treats the
pair `roles:edit` + `users:edit` as the administrative capability, runs inside the
same transaction as the mutation, and rejects role reassignments, deactivations,
or permission-set edits that would remove the final admin — but only when the
company actually had an admin to begin with, so unrelated changes are never
collaterally blocked.
`apps/api/src/common/admin-lockout/admin-lockout-guard.service.ts:11`
(admin definition),
`apps/api/src/common/admin-lockout/admin-lockout-guard.service.ts:42-69`
(`assertAdminRemains`). It is wired into every privileged mutation:
`apps/api/src/users/users.service.ts:275-277` (role change),
`apps/api/src/users/users.service.ts:323-325` (deactivate),
`apps/api/src/roles/roles.service.ts:129-131` (permission-set edit).

**Full user lifecycle with membership-scoped access.** Users are created directly,
invited by email (an invite has no usable password until the recipient sets one
via a tokenised link — and an email is mandatory for that path), or linked from an
existing cross-company identity; roles are changed; access is deactivated (never
hard-deleted). Access is a `CompanyMembership`, so revoking a user's access to one
tenant leaves their logins at other tenants untouched.
`apps/api/src/users/users.service.ts:45-134` (create/invite),
`apps/api/src/users/users.service.ts:144-214` (link existing),
`apps/api/src/users/users.service.ts:251-308` (role change),
`apps/api/src/users/users.service.ts:310-404` (deactivate, including the
operator-archive cascade).

### Audit trail for privilege changes

**Privileged access-control actions are written to an append-only audit log.**
The security audit table is append-only by database grant — the runtime roles hold
`SELECT, INSERT` on `audit_logs` with no `UPDATE`/`DELETE`, and the table is under
`FORCE ROW LEVEL SECURITY` with a tenant-isolation policy — so the trail cannot be
rewritten by the application.
`apps/api/prisma/migrations/20260724120000_audit_log/migration.sql:26-35`.
`AuditService.recordInTx` writes the entry inside the same tenant transaction as
the action, so an audit row and the change it describes commit atomically.
`apps/api/src/audit/audit.service.ts:8-20` (action catalogue),
`apps/api/src/audit/audit.service.ts:67-69` (`recordInTx`).

**The privilege-change events are actually emitted.** Every access-control
mutation records the auditor-facing event: `USER_CREATED` on both create and
link-existing, `USER_ROLE_CHANGED` on a role move, `USER_ACCESS_REVOKED` on
deactivation (including the operator-archive cascade), and
`ROLE_PERMISSIONS_CHANGED` on a permission-set change — the latter carrying the
before/after key lists and firing only when the set actually moved.
`apps/api/src/users/users.service.ts:110-116`, `:200-210`, `:297-303`, `:343-349`,
`:393-400`; `apps/api/src/roles/roles.service.ts:175-183`. These are readable by an
auditor through `GET /v1/audit-logs`, itself gated behind the `audit:view`
permission.
`apps/api/src/audit/audit.controller.ts:14-15`.

### Authentication and session revocation supporting access control

**Password authentication with brute-force lockout.** Logins are bcrypt-verified
and locked after five consecutive failures for a fixed window; failed logins and
lockouts are recorded to the audit log (with IP and request id) via the
system-scoped path.
`apps/api/src/auth/auth.service.ts:281` (`MAX_FAILED_LOGINS = 5`),
`apps/api/src/auth/auth.service.ts:286-291` (lockout), `:80-102` (enforcement and
audit).

**Session tokens are revocable and algorithm-pinned.** The session JWT embeds a
per-user `tokenVersion` that `JwtStrategy` re-checks against the database on every
request, so bumping it (done on password reset, and also invalidating archived
users) revokes outstanding sessions; a mismatch returns `TOKEN_REVOKED`. JWT
verification pins `algorithms: ['HS256']`, closing algorithm-substitution as a
class.
`apps/api/src/auth/strategies/jwt.strategy.ts:35-41` (revocation check),
`apps/api/src/auth/strategies/jwt.strategy.ts:23` (algorithm pin).

**No default administrative accounts reach production.** The database seed gates
its two demo companies — which carry a source-visible default admin password —
behind `NODE_ENV !== 'production'`; in production the seed runs reference data and
system-role reconciliation only. The deploy workflow sets `NODE_ENV=production` on
the seed step, and env validation independently refuses to boot if a connection
string still contains a known dev-only database-role password.
`apps/api/prisma/seed.ts:162` (production gate),
`.github/workflows/deploy-api.yml:116-117` (`NODE_ENV=production`),
`apps/api/src/config/env.validation.ts:33` and `:70-76` (dev-password fail-fast).

## Gaps & residual risk

| Gap | Severity | Plan |
|-----|----------|------|
| **`PermissionGuard` fails open on routes with no `@RequirePermission`.** `canActivate` returns `true` when no permission metadata is present, so an authenticated user of any role reaches such a route; correctness rests on developer convention that every data-touching route declares a permission. `apps/api/src/common/guards/permission.guard.ts:29-35`. | medium | Add a CI/integration test that enumerates all registered routes and asserts each declares `@RequirePermission` or `@Public` (with an explicit allowlist for legitimately self-scoped personal routes), or invert the guard to deny unless explicitly annotated. |
| **No separation-of-duties limit on self-privilege-escalation.** A holder of `users:edit` can reassign any membership — including their own — to a more-privileged role, and `roles:edit` can add any permission to a role the caller holds. The last-admin guard prevents *removing* the last admin but does not prevent escalation. `apps/api/src/users/users.service.ts:251-308`; `apps/api/src/roles/roles.service.ts:107-187`. | medium | Treat `users:edit`/`roles:edit` as sparingly-granted admin-tier permissions (document this), and add a self-edit guard blocking a user from changing their own membership role or editing the permission set of a role they currently hold. |
| **No multi-factor authentication for privileged accounts.** Authentication is password + lockout only; there is no TOTP/WebAuthn second factor for admin-tier accounts (`users:edit`, `roles:edit`, `billing:manage`). Cyber Essentials (2023+) treats MFA on cloud/administrative accounts as mandatory, so although the access-control impact is bounded by RLS and RBAC, this is the headline gap; it is tracked at higher severity in docs 07 (authentication) and 08 (device & session). | medium | Add optional, per-role-enforceable TOTP or WebAuthn, gated for accounts holding administrative permissions, with a second step in the login flow before a session token is issued. |
| **No authenticated self-service password change.** Only the email-token forgot/reset flow exists; there is no "change my password while logged in" endpoint that re-verifies the current password, and it depends on `User.email` which is nullable. `apps/api/src/auth/auth.controller.ts` (endpoints: login, select-company, forgot/reset/verify — no change-password). | low | Add an authenticated `POST /v1/auth/change-password` that verifies the current password, applies the strong-password policy, and increments `tokenVersion` to revoke other sessions. |
| **Session revocation is coarse and there is no explicit logout.** Sessions are revocable only en masse by bumping `tokenVersion` (currently only on password reset / archive); there is no logout endpoint, no per-session/per-device listing or revocation, and no idle/absolute timeout beyond the 12h JWT expiry. `apps/api/src/auth/strategies/jwt.strategy.ts:35-41`; `apps/api/src/auth/auth.module.ts:21` (12h default expiry). | low | Add a logout / "sign out everywhere" action that bumps `tokenVersion`, and consider shorter-lived access tokens with a refresh token or per-session `jti` denylist plus an admin "revoke this user's sessions" action. |

## Standards mapping

**Cyber Essentials — User access control.** Well met on the technical core:
database-enforced tenant isolation, least-privilege runtime roles, a fine-grained
permission model resolved per request, last-admin protection, an append-only
privilege-change audit trail, and the removal of default administrative accounts
from production. The one Cyber Essentials expectation not yet satisfied is MFA on
administrative/cloud accounts (see Gaps).

**ISO/IEC 27001:2022 Annex A.**
- *A.5.15 Access control* — satisfied: RLS at the data tier plus a documented
  role/permission model define access on both need-to-know and least-privilege
  lines.
- *A.5.16 Identity management* — largely satisfied: globally-unique user identities
  with per-company memberships and a full create/invite/link/deactivate lifecycle;
  identity assurance is single-factor pending MFA.
- *A.5.18 Access rights* — satisfied for provisioning, modification, and removal
  (deactivation, operator-archive cascade), each audited; access-rights *review* is
  supported by `GET /v1/audit-logs` but a periodic recertification process is
  organisational, not evidenced in code.
- *A.8.2 Privileged access rights* — partially met: privileged actions are gated by
  admin-tier permissions, protected by the last-admin guard, and audited, but there
  is no separation-of-duties constraint on self-escalation and no MFA for privileged
  users.
- *A.8.3 Information access restriction* — strongly met: `FORCE ROW LEVEL SECURITY`
  makes cross-tenant information access structurally impossible for the runtime role.

**SOC 2 (2017 TSC) Common Criteria.**
- *CC6.1 (logical access — protect information assets)* — strongly supported by RLS,
  least-privilege database roles, and per-request permission checks.
- *CC6.2 (registration/authorisation of users)* — supported by the membership-based
  provisioning lifecycle with an audit trail on create/link/role-change/revoke.
- *CC6.3 (modify/remove access based on roles)* — supported by role-based
  authorisation, the archive-not-delete model, and deactivation; the residual
  weaknesses are the fail-open guard default, the absence of a self-escalation
  control, and single-factor authentication.
