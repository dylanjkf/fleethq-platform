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
| 2 | Magic link + social login + WebAuthn-ready architecture | **Done** |
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

## Phase 2: Magic link + social login + WebAuthn-ready architecture

Three independent first-factor login methods, all landing on the same
device-trust/MFA gate (or, for WebAuthn, deliberately bypassing it — see
below) that password login already used.

**Data model** — `prisma/migrations/20260731070000_magic_link_oauth_webauthn/`:

- `AuthTokenType` gained `MAGIC_LINK` (15-minute TTL — a live login attempt,
  not a link meant to sit in an inbox, unlike `EMAIL_VERIFY`'s 24h or
  `PASSWORD_RESET`'s 1h). Reuses the existing single-use, SHA-256-hashed
  `AuthToken`/`AuthTokensService` machinery — no new token infrastructure.
- `user_oauth_identities` — `(provider, providerSubject)` unique pair per
  user, `provider` restricted to `GOOGLE`/`MICROSOFT`. First successful login
  from a given external identity auto-links it by verified email (refusing
  ambiguity if more than one account shares that email); every later login
  resolves through this table instead.
- `user_webauthn_credentials` — one row per passkey: `credentialId` (unique),
  `publicKey` (COSE, raw bytes), `signCount`, `transports`, optional
  `deviceLabel`. Both tables are granted only to the narrow `fleetos_auth`
  role, matching `users`/`auth_tokens`/`user_sessions`.

**Social login is sign-in only** — consistent with the product's
no-self-service-signup decision, a Google/Microsoft login can attach to an
existing account but never creates one. `OidcVerifierService`
(`src/auth/oidc-verifier.service.ts`) does real cryptographic verification
against each provider's live, rotating JWKS (`jose`'s `createRemoteJWKSet` +
`jwtVerify`) — never trusts a client-supplied claim. Google's issuer is a
fixed string; Microsoft's varies per tenant for the multi-tenant
`common`/`organizations`/`consumers` endpoints, so a regex checks the issuer
shape unless a specific tenant GUID is configured. `isConfigured(provider)`
gates everything else — with no client ID configured for a provider, it's
simply absent from `GET /v1/auth/providers` and the login endpoint refuses
cleanly with `PROVIDER_NOT_CONFIGURED`, mirroring `NotificationsModule`'s
SES-vs-logging-channel config gating.

**WebAuthn/passkeys are usernameless (discoverable-credential) login** — no
identifier needed; the browser/OS credential picker resolves the account via
the credential's own stored user handle (`src/auth/webauthn/webauthn.service.ts`,
built on `@simplewebauthn/server`). Registration/authentication challenges are
short-lived (2-minute) signed JWTs carrying the challenge string, mirroring
the existing `PreAuthJwtPayload`/`MfaChallengePayload` pattern — no new
server-side session-state table. **A verified passkey login is treated as
already satisfying MFA and bypasses the account's own TOTP policy entirely**
(`AuthService.completeWebauthnLogin`) — a deliberate product decision:
possession of the authenticator plus the platform's own biometric/PIN
presence check is itself multi-factor-equivalent.

**Login-method tracking**: a new `LoginMethod` type
(`'password' | 'magic_link' | 'oauth_google' | 'oauth_microsoft' | 'webauthn'`)
threads through `MfaChallengePayload`/`PreAuthJwtPayload` so it survives the
MFA-challenge and multi-company-chooser hops, ultimately recorded in
`LOGIN_SUCCEEDED` audit metadata — the start of real login-method visibility
in the audit trail, not just "a login happened."

**Service split**: `auth.service.ts` was growing past the repo's 500-line
lint ceiling, so session/device methods extracted into `AuthSessionsService`
and account-recovery methods (`forgotPassword`/`resetPassword`/`verifyEmail`/
`resendVerification`) into `AuthRecoveryService` — the same god-service-split
pattern used earlier for `JobStopsService`. `AuthService` itself now
orchestrates: password/magic-link/OAuth logins all share one private
`proceedPastFirstFactor()` tail (device-trust check → MFA challenge or
straight through), while WebAuthn calls `completeLogin()` directly since it
skips that gate by design.

**New endpoints**: `GET /v1/auth/providers` (which passwordless/social
options to offer), `POST /v1/auth/magic-link/request` + `/consume`, `POST
/v1/auth/oauth/:provider/login`, and six WebAuthn endpoints (registration
options/verify, list/revoke credentials — all authenticated; login
options/verify — public, since there's no identifier yet to authenticate).

**Frontend** (`fleethq-frontend`): `LoginPage` gained a provider-conditional
button stack ("Email me a sign-in link", "Continue with a passkey", and
"Continue with Google"/"Continue with Microsoft" only when
`GET /v1/auth/providers` reports them configured) plus its own magic-link
sub-form. `signInWithOidcPopup` (`src/lib/oauth-popup.ts`) is a
dependency-free OpenID Connect implicit-flow popup helper — both providers
share one code path rather than each getting a bespoke SDK integration
(GSI/MSAL.js), trading a slightly less polished button for a simpler,
single, auditable flow; it requests only an `id_token` (this app never needs
an access token) and validates a `state` value against the popup's redirect
to guard the handoff — the backend's own signature/issuer/audience check is
what actually establishes trust in the token. New `MagicLinkPage`
(consume-on-mount, same pattern as `VerifyEmailPage`) and a minimal
`OAuthCallbackPage` (the popup does all the real work; this page only needs
to exist so the provider has somewhere to land). New `PasskeysCard` on the
Profile page (enroll via `startRegistration`, list/revoke), mirroring
`SessionsCard`'s structure.

**Testing note**: WebAuthn's backend test (`test/auth-passwordless.e2e-spec.ts`)
drives a from-scratch `VirtualAuthenticator` — a real P-256 keypair, hand-built
CBOR attestation objects, real ECDSA signatures — through the actual
`@simplewebauthn/server` verification code, rather than mocking it. The full
password → passkey-enrollment → passkey-login → magic-link-request round
trip was also verified in a real headless browser (Chrome DevTools Protocol's
`WebAuthn.addVirtualAuthenticator`), not just at the API layer. OAuth's
positive path (a real Google/Microsoft `id_token`) is not covered by an
automated test — that would need a live IdP sandbox or a DI-override hook
`buildTestApp()` doesn't currently expose — so coverage is scoped to the
negative/gating paths (unconfigured provider, unknown provider name), a
known and accepted boundary.

**Not yet covered by this phase**: per-org mandatory-MFA policy (Phase 3),
login-history browsing UI (still just audit-log rows).
