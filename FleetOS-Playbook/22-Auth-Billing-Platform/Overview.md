# Authentication, Billing & Subscription Platform

An 11-phase initiative closing the gaps between what FleetHQ's auth/billing
stack had (A2–A4: verification, reset, lockout, plan tiers, entitlements —
see `19-Billing/Billing_And_Subscriptions.md` and `14-Security/Security_Review.md`)
and a full enterprise-grade requirement: modern authentication with real
per-device session management, deeper registration, richer RBAC, complete
Stripe webhook/lifecycle coverage, a real customer billing portal, GST tax
invoicing, and security hardening depth.

This document tracks what's actually built, phase by phase, so it never
drifts into describing features that don't exist yet.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Customer session & device management | **Done** |
| 2 | Magic link + social login + WebAuthn-ready architecture | Planned |
| 3 | Password policy depth + per-org mandatory-MFA policy | Planned |
| 4 | Registration depth (org intake fields) + named role templates | Planned |
| 5 | Full Stripe webhook coverage + failed-payment handling | Planned |
| 6 | Billing & security notification emails | Planned |
| 7 | Customer self-service billing portal UI | Planned |
| 8 | GST / Australian tax invoicing | Planned |
| 9 | Usage & feature limit depth | Planned |
| 10 | Security hardening depth | Planned |
| 11 | Final verify, docs, CHANGELOG | Planned |

## Phase 1: Customer session & device management

Mirrors the admin platform's own session model (`21-Admin-Platform/Overview.md`)
for customer `User` accounts, replacing the previous "one long-lived JWT with
no server-side revocation short of a full tokenVersion bump" design.

**Data model** — `prisma/migrations/20260731062654_customer_sessions_devices/`:

- `user_sessions` — one row per issued session: `userId`, `companyId`,
  `membershipId`, `ipAddress`, `userAgent`, `deviceLabel`, `createdAt`,
  `lastSeenAt`, `expiresAt`, `revokedAt`. Not RLS-protected (no tenant context
  exists at login time) — touched only by the narrow, BYPASSRLS
  `fleetos_auth` role, the same treatment `users`/`auth_tokens` already get.
- `user_trusted_devices` — one row per `(userId, deviceFingerprint)`: the
  fingerprint is SHA-256 hashed before storage (never kept raw), `expiresAt`
  30 days out. A valid row skips the MFA challenge on that device.

**JWT payload** (`src/auth/jwt-payload.interface.ts`) gained a `sid` claim
naming the `UserSession` row backing the token. `JwtStrategy.validate()`
(`src/auth/strategies/jwt.strategy.ts`) now checks that row's
`revokedAt`/`expiresAt` on every request, independent of the JWT's own signed
`exp` — this is what makes "log out" or "revoke this session" take effect
immediately rather than waiting out the token's lifetime. A fire-and-forget
`lastSeenAt` bump keeps the session list's "last seen" honest without adding
latency to every authenticated request.

**Auth flows** (`src/auth/auth.service.ts`):

- `login()` accepts an optional client-generated `deviceFingerprint` and a
  `rememberMe` flag. A trusted device skips the MFA challenge; any other
  device — regardless of whether MFA is even enabled — triggers a
  best-effort "new sign-in from an unrecognised device" email
  (`AuthMailService.sendNewDeviceLogin`). This is a known, accepted
  simplification: without MFA there's no "remember this device" action, so
  the alert fires on every login for an account that never opts in to
  remembering a device.
- `rememberMe` extends both the session row's `expiresAt` and the JWT's own
  `expiresIn` from 12h to 30 days. It's threaded through the MFA-challenge
  and pre-auth (multi-company chooser) tokens so it still applies however
  many steps a login takes to complete.
- `verifyMfaChallenge()` accepts `rememberDevice` — on success, upserts a
  `UserTrustedDevice` row (SHA-256 hash of the fingerprint), mirroring
  `AdminAuthService`'s equivalent.
- New endpoints on `AuthController`: `GET /v1/auth/sessions` (list this
  user's active sessions, current one flagged), `DELETE
  /v1/auth/sessions/:id` (self-service revoke — ownership-checked), `POST
  /v1/auth/logout` (revoke the session named by the current token).
- `resetPassword()` now also revokes every `UserSession` row for that user
  (previously only the `tokenVersion` bump enforced this — correct in
  effect, but left stale-looking "active" session rows behind).
- `issueSessionToken()` (also used by `CompaniesService.signup()` and
  `AdminOrganisationsService.impersonate()`) now always creates a real
  `UserSession` row and embeds its id as `sid` — a token minted without one
  would be rejected by `JwtStrategy` on its very first use.

**Frontend** (`fleethq-frontend`): `AuthProvider`/`api/auth.ts` thread a
per-browser device fingerprint (persisted in `localStorage`, mirroring the
admin SPA's `getOrCreateDeviceFingerprint`), a "remember me" checkbox on
login, and a "remember this device" checkbox on the MFA step. `logout()` now
calls the real revoke endpoint (best-effort — a failed request never blocks
the local sign-out). A new `SessionsCard` on the Profile page lists active
sessions and lets a user revoke any but the current one, mirroring the admin
SPA's own `SessionsCard`.

**Not yet covered by this phase**: login-history browsing UI (the
`audit_logs` table already records `auth.login_succeeded`/`auth.login_failed`
per company; no dedicated endpoint/UI surfaces it yet), WebAuthn/passkeys
(Phase 2), per-org mandatory-MFA policy (Phase 3).
