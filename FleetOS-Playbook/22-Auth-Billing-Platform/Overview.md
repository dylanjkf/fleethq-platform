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
| 3 | Password policy depth + per-org mandatory-MFA policy | **Done** |
| 4 | Registration depth (org intake fields) + named role templates | **Done** |
| 5 | Full Stripe webhook coverage + failed-payment handling | **Done** |
| 6 | Billing & security notification emails | **Done** |
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

## Phase 3: Password policy depth + per-org mandatory-MFA policy

Two independent company-level security policies, both evaluated at the one
point a login resolves to a specific company membership — not at
`proceedPastFirstFactor`, which runs before a company is even known for a
multi-company user.

**Data model** — `prisma/migrations/20260731080000_password_policy_mfa_policy/`:

- `users.password_changed_at` — stamped on every password set (signup,
  reset, self-service change, expiry-forced change) so a policy can measure
  age; backfilled to `now()` for existing rows.
- `user_password_history` — the previous password hash, inserted right
  before it's overwritten. Not RLS-protected (fleetos_auth-only, same
  treatment as `users`/`auth_tokens`) and capped at the 5 most recent
  entries per user (`PasswordPolicyService`), pruned on write.
- `company_security_settings` — one row per company: `mfaRequired boolean`,
  `passwordExpiryDays int?` (`null` = no expiry). RLS-protected with the
  same two-branch (`current_company_id` OR membership-based
  `current_user_id`) policy as `companies` itself — deliberately not
  single-branch like most per-company settings tables, because it's the one
  settings row read *during login*, before a tenant context is chosen
  (`AuthService.resolveActiveMembership` runs inside
  `PrismaService.withUser`, not `withTenant`).

**Password reuse prevention is a fixed global rule, not per-company** —
`PasswordPolicyService.assertNotReused` checks the current hash plus the
last 5 in `user_password_history`. A per-company configurable history depth
had no non-arbitrary answer for a user who belongs to more than one company,
so this one rule applies everywhere a password is set.

**The policy gate** (`AuthPolicyGateService.checkPolicy`) runs inside a new
shared tail, `AuthService.finishLoginForMembership` — called from
`completeLogin`'s single-membership branch, `selectCompany` (the
multi-company chooser's second step), and the two policy-resume endpoints
below — so a mandatory policy is enforced identically regardless of how many
steps a login took to reach a specific company. It checks MFA first, then
password expiry:

- **Mandatory MFA**: if the company requires it and the account doesn't have
  TOTP enabled, blocks with `mfa_setup_required` + a short-lived
  (15-minute) `setupToken` — unless the login method was `webauthn`, which
  (per Phase 2's own rationale) already counts as MFA-equivalent on its own.
- **Password expiry**: if `passwordChangedAt` is older than
  `passwordExpiryDays`, blocks with `password_expired` + a `changeToken`.
- The two can chain: finishing forced MFA enrolment re-runs the same policy
  check, so an account that's *also* carrying a stale password comes back
  `password_expired` rather than silently completing the login.

Both tokens are stateless short-lived JWTs (`PolicyActionPayload`, mirroring
the existing `MfaChallengePayload`/`PreAuthJwtPayload` pattern) — no new
server-side session-state table, and (like those existing tokens)
deliberately reusable within their validity window rather than single-use.

**New endpoints** on `AuthController`: `POST /v1/auth/mfa-setup/begin` +
`/confirm` (issue the TOTP secret, then confirm a code — activating MFA and
resuming the blocked login), `POST /v1/auth/password-expired/change` (set a
new password and resume), and `POST /v1/auth/change-password` (authenticated
self-service change, requiring the current password — the other password-
change path, independent of any policy gate).

**Company security policy management**: a new `SecuritySettingsModule`
(`GET`/`PUT /v1/security-settings`, gated on the new
`security_policy:manage` permission) lets an Administrator toggle
`mfaRequired` and set/clear `passwordExpiryDays` (7–365 days). `GET
/v1/auth/me` gained `mfaRequiredByCompany` so the Profile page can explain
*why* "Disable MFA" is unavailable, rather than the account only discovering
the policy the next time it tries to log in without it.

**Frontend** (`fleethq-frontend`): `LoginPage` gained `mfa_setup_required`
and `password_expired` states — the former shows the TOTP secret and a code
field (reusing `MfaCard`'s enrollment copy), then one-time backup codes
before resuming; the latter is a new-password form. Both states, and the
company chooser (`selectCompany`), now funnel through the same
`handleResult` router instead of assuming `authenticated` is the only
possible outcome — a real, if narrow, pre-existing gap in the multi-company
chooser path that this phase's chaining behavior newly exercises. `MfaCard`
disables "Disable" (with an explanation) when `mfaRequiredByCompany` is
true. New `ChangePasswordCard` on the Profile page. New "Security" tab on
the Administration page (`SecuritySettingsTab`) for editing the company
policy, gated on `security_policy:manage`.

**A note on due diligence**: implementing `selectCompany`'s equivalent policy
check surfaced a genuine pre-existing bug, unrelated to this phase's own
code — `resolveActiveMembership`'s query joined `User` through a
`PrismaService.withUser`-scoped transaction (only `app.current_user_id` set),
but the `users` table's RLS policy has no "visible to self" branch, only a
`current_company_id` one (unlike `companies`/`company_memberships`, which
got a two-branch policy fix earlier). The join silently failed RLS and
Prisma's own consistency check raised on the missing required relation.
Zero e2e tests had ever exercised `POST /v1/auth/select-company` before this
phase added one. Fixed by fetching `User` via `SystemPrismaService`
(the pattern already used everywhere else in `auth.service.ts`) instead of
joining it through the RLS-scoped query, rather than touching the
security-sensitive `users` RLS policy itself.

**Not yet covered by this phase**: an audit-log-driven view of *when* a
company's security policy last changed beyond the existing
`security.settings_updated` audit action; a grace period between a password
expiring and the account being blocked (it blocks immediately at next login).

## Phase 4: Registration depth + named role templates

Two independent pieces of depth on top of `POST /v1/companies` (Phase 1's
provisioning path, kept for direct/internal use — see Phase 1's own
`Company signup` e2e spec comment) and `provisionCompany`.

**Registration depth** — five new `Company` columns
(`prisma/migrations/20260731090000_registration_depth_role_templates/`):

- `abn` — 11-digit Australian Business Number, validated at intake against
  the real ABR checksum algorithm (`IsAbn`, `src/common/validators/is-abn.validator.ts`),
  not just "is this an 11-digit string."
- `industry`, `phone`, `fleetSizeEstimate` — free-text/numeric onboarding
  fields, all optional and purely descriptive.
- `termsAcceptedAt` — **mandatory** at signup (`SignupCompanyDto.acceptedTerms`
  must be exactly `true`, enforced via `@Equals(true)`, not just `@IsBoolean()`)
  and stamped with `new Date()` by `CompaniesService.signup()`. A genuine gap
  this phase closes: the platform had real legal documents
  (`20-Legal/Terms_of_Service.DRAFT.md`, `Privacy_Policy.DRAFT.md`) but no
  record that anyone had ever agreed to them. Internal dev/seed scripts don't
  set it (the column is nullable for exactly that reason — same treatment as
  `trialDays`).

All five are editable after signup via the existing `PATCH /v1/companies/me`
(`companies:edit`), and shown/edited on the FleetHQ Administration → Company
tab.

**Named role templates** — beyond the existing Administrator/Read Only/Driver
trio, four new purpose-built system-template roles a new company starts with:
**Dispatcher** (runs the job board — dispatch, customers, messaging),
**Fleet/Workshop Manager** (assets, attached units, maintenance, parts),
**Compliance Officer** (compliance documents, fatigue rules, the security
audit log, Privacy Act requests), and **Accounts** (billing, financial/
operational reports). `provisionCompany` and `prisma/reconcile-permissions.ts`
were both rewritten to loop over a single `ROLE_TEMPLATES` catalog
(`src/common/permissions/permission-catalog.ts`) instead of one hand-written
block per role name — the previous shape (3 near-duplicate blocks) would have
become 7 with this phase, past the point copy-paste stays maintainable.

**Two real bugs the rewrite surfaced** (both only reachable once a fleet has
enough tenants/history to hit them, which is exactly why they'd gone
unnoticed): `Role` has a `(companyId, name)` unique constraint with no
exemption for `archivedAt` or `isSystemTemplate` — so (a) a company that
archived its own copy of a system-template role must still count as "has
that name," not "missing it," or reconciliation tries to insert a duplicate;
and (b) a company with its own **custom** role that happens to share a new
template's name (e.g. an Administrator hand-built a role called
"Dispatcher" before the template existed) hits the exact same constraint.
Both are now handled by checking for *any* role with that name (archived or
custom) before deciding a company is missing a template, and only ever
mutating active system-template roles' permissions.

**Also fixed in the same rewrite**: the previous reconciliation implementation
fetched every existing role's full permission set into memory and issued one
`rolePermission.createMany` call *per role* to grant what was missing — an
N+1 pattern that stops scaling once a fleet reaches thousands of tenants (this
codebase's own dev database, after a long test history, made the cost
concrete: a single reconciliation run went from timing out to completing in
seconds). The rewrite instead always attempts to insert every (role × target
permission) pair with `skipDuplicates: true` in batches — Postgres silently
no-ops what a role already has, and the returned count is exactly how many
were actually missing, all without ever reading existing permission rows back
into the application.

**Not yet covered by this phase**: a "start from a template" picker in the
Roles UI's own create-role dialog (new templates only reach a company via
initial provisioning or the `permissions:sync` backfill, not on demand);
industry as a fixed, curated list rather than free text.

## Phase 5: Full Stripe webhook coverage + failed-payment handling

Before this phase, `BillingService.handleWebhookEvent`
(`src/billing/billing.service.ts`) only handled `checkout.session.completed`
and the three `customer.subscription.*` events — every invoice/payment event
fell into the `default:` no-op branch, on the theory that a failed invoice
already surfaces indirectly via the subscription's own status going
`past_due`. That's true for *entitlements* (see below), but it meant no
record of *when* a payment failed, no retry-schedule visibility, and nothing
that would let a "you have a failed payment" UI (Phase 7) exist.

**New `Company` columns** (`prisma/migrations/20260731100000_billing_payment_failure_tracking/`):

- `paymentFailureCount` — incremented on every `invoice.payment_failed`,
  reset to `0` on the next successful `invoice.paid`. Purely observational:
  per `19-Billing/Billing_And_Subscriptions.md`'s "billing informs, never
  hard-locks" v1 decision, this does **not** by itself change entitlements —
  `subscriptionStatus` going `PAST_DUE` (already handled before this phase)
  is what that decision is actually about, and `PAST_DUE` deliberately stays
  in `plans.ts`'s `ACTIVE_STATUSES`. This phase doesn't touch that.
- `lastPaymentFailedAt` — never cleared on recovery, a historical "has this
  company ever had a failed payment" marker for a future support/dunning
  view.
- `nextPaymentAttemptAt` — Stripe's own retry schedule
  (`invoice.next_payment_attempt`), surfaced through `GET /v1/billing/status`
  so a billing settings page can say exactly when the next charge attempt
  will happen, not just "your payment failed."

**Two new webhook cases** in `BillingService.handleWebhookEvent`:

- `invoice.payment_failed` — resolves the company via
  `invoice.parent.subscription_details.metadata.fleetosCompanyId`, which
  Stripe snapshots onto the invoice at finalization; no extra Stripe API
  round-trip needed (unlike `checkout.session.completed`, which still has to
  retrieve the subscription since the checkout session event itself doesn't
  carry that metadata). Increments `paymentFailureCount`, stamps
  `lastPaymentFailedAt`/`nextPaymentAttemptAt`, and fans an in-app
  notification (`billing.payment_failed`) out to every `billing:manage`
  holder via the existing `NotificationsService.notifyPermissionInTx` — the
  same cross-cutting mechanism Compliance/Messages/etc. already use, not new
  infrastructure.
- `invoice.paid` — resets `paymentFailureCount`/`nextPaymentAttemptAt`, and
  **only** notifies (`billing.payment_recovered`) when this payment actually
  recovered the company from a prior failure (`paymentFailureCount` was
  `> 0`), never on a routine on-time renewal — otherwise "you're all paid up"
  would fire every billing cycle for the overwhelmingly common case where
  nothing was ever wrong. `invoice.payment_succeeded` (the older, still-fired
  alias for the same event) is deliberately left unhandled to avoid
  double-counting/double-notifying a single real-world payment.

Both new handlers are `private` methods on `BillingService`, and the
`checkout.session.completed`/subscription-created/updated/deleted cases were
each extracted into their own private method too (`handleCheckoutSessionCompleted`,
`handleSubscriptionEvent`) — adding two more cases to what was a single large
`switch` pushed `handleWebhookEvent` over this repo's own complexity lint
ceiling; extracting kept the dispatch switch itself trivial regardless of how
many event types it now handles.

**Deliberately out of scope for this phase** (see Phase 6/7's own scope):
sending an actual *email* for a failed/recovered payment — only the in-app
notification exists so far, since Phase 6 ("Billing & security notification
emails") is where the dedicated email templates and channel wiring belong;
any change to entitlement/enforcement behavior on repeated failures (still
governed entirely by `subscriptionStatus`, unchanged by this phase); and any
UI surfacing `paymentFailureCount`/`nextPaymentAttemptAt` on a billing
settings page (Phase 7, "Customer self-service billing portal UI" — the data
is there now, plumbing it into a UI is that phase's job).

## Phase 6: Billing & security notification emails

Two independent sets of transactional emails, both riding the existing
`NotificationChannel` abstraction (real SES when configured, log-only
otherwise) — no new email infrastructure anywhere in this phase.

**Billing emails** — a new `BillingMailService` (`src/billing/billing-mail.service.ts`),
mirroring `AuthMailService`'s one-method-per-email shape: `sendPaymentFailed`
and `sendPaymentRecovered`. Wired into the exact two webhook handlers Phase 5
built (`handleInvoicePaymentFailed`/`handleInvoicePaymentSucceeded`), which
already computed everything the emails need (next retry date, whether this
was a genuine recovery) while raising the in-app notification — the DB
update/in-app-notification/recipient-lookup all happen inside the existing
`withTenant` transaction, and the emails fire *after* it commits, fire-and-
forget (a slow/failed email provider must never roll back billing state).
Recipients are every `billing:manage` holder with an email on file — a new
`NotificationsService.getPermissionHolders(tx, permissionKey)` helper
returns `{id, fullName, email}` for exactly the same audience
`notifyPermissionInTx` would reach, kept as a separate query so the common
in-app-only callers don't pay for profile fields they never use.

**Security emails** — four gaps found by auditing every security-relevant
account event for whether it already emailed anyone (all four already had
audit-log coverage; email was the only missing piece):

- **Password changed** (`AuthMailService.sendPasswordChanged`) — fires from
  all three paths that end in a new password hash: self-service
  `changePassword`, a completed `resetPassword`, and the policy-forced
  `changeExpiredPassword`. Distinct from the existing `sendPasswordReset`,
  which only sends the *link* that starts a reset — this is the "it actually
  happened" confirmation, the one signal an account holder has if a password
  changed without them requesting it.
- **MFA enabled** (`sendMfaEnabled`) / **MFA disabled** (`sendMfaDisabled`)
  — fire from `MfaService.confirmEnrollment`/`disable`. MFA being turned
  *off* is the higher-value alert of the two (a classic account-takeover
  step); both emails say so plainly.
- **Account locked** (`sendAccountLocked`) — fires from `AuthService.login()`
  once `recordFailedLogin` actually flips the account to locked, reporting
  the real computed unlock time. The lockout-handling block (audit record +
  new email call) was extracted into a private `handleAccountLocked` method
  — adding the email call pushed `login()` over this repo's line-count/
  complexity lint ceiling, and login's control flow doesn't benefit from
  three more inline statements from a different concern (security alerting)
  living directly in the credential-check branch.

**Deliberately out of scope**: a new-passkey-registered email — the research
for this phase found `WebauthnService.verifyRegistration` has **no** audit
trail either (the one security event genuinely uncovered on both counts,
not just email), and closing that gap cleanly would mean adding a new
`AUDIT_ACTIONS` entry first — a small enough change to be worth doing
deliberately in a later phase rather than folding into this one's scope.
Also out of scope: admin-forced session revocation has no email hook simply
because the feature itself doesn't exist in this codebase — revocation is
always self-service (confirmed by reading every call site of
`AuthSessionsService.revokeSession`/`revokeAllSessions`).

**Testing**: unit specs (`auth-mail.service.spec.ts`, `billing-mail.service.spec.ts`)
verify each new email's recipient/subject/body against a stub
`NotificationChannel` — the codebase's own established boundary is that
outbound email *content* is unit-tested against the channel abstraction, not
asserted on inside the e2e suite (no e2e spec anywhere overrides
`NOTIFICATION_CHANNEL` to capture what was sent); the e2e suites already
covering password change/reset, MFA enable/disable, and lockout
(`auth-completeness`, `auth-security-policy`, `mfa`) continued passing
unchanged, confirming the new fire-and-forget calls don't throw or otherwise
disrupt those flows.
