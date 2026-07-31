# Changelog

All notable decisions and revisions to the FleetOS Playbook are recorded here, newest first.

## 2026-07-31 — Auth/Billing Platform, Phase 11 (final verify, docs, CHANGELOG — initiative complete)

Closing phase of the 11-phase Authentication, Billing & Subscription Platform initiative — no new functionality, a whole-initiative verification pass plus documentation.

- Backend: full `jest` suite re-run clean (553/554 — the one failure is the pre-existing `integrations.e2e-spec.ts` webhook-timeout flake, confirmed unrelated throughout the initiative); `tsc -b` and `eslint` clean.
- Frontend: `tsc -b` clean, `oxlint` clean, `vitest` (38/38) passing, `npm run build` succeeds.
- `22-Auth-Billing-Platform/Overview.md` gained a closing section collecting every phase's "deliberately out of scope" note into one place (step-up re-auth, refresh-token rotation, new-passkey audit event, new limit dimensions, gated Stripe Tax) so a future reader doesn't have to hunt through ten sections for the honest list of what's still missing. `19-Billing/Billing_And_Subscriptions.md` gained pointers to Phase 9's usage counters.
- All 11 phases are now **Done**: customer session/device management, magic link + social login + WebAuthn, password/MFA policy depth, registration + named roles, full Stripe webhook coverage, billing/security emails, self-service billing portal UI, GST tax invoicing, usage & feature limit depth, security hardening depth, and this closing verification pass.

## 2026-07-31 — Auth/Billing Platform, Phase 10 (security hardening depth)

Re-reviewed the auth/session layer this initiative itself built (Phases 1–3) with an attacker's checklist, closing five concrete gaps rather than re-doing the broad security work already done pre-initiative (Waves C/E, etc.).

- Self-service password change (`AuthRecoveryService.changePassword`) and MFA enable/disable (`MfaService.confirmEnrollment`/`disable`) now revoke every *other* active session via a new `AuthSessionsService.revokeOtherSessions` — the acting session stays alive, everything else dies immediately instead of surviving on its own leftover lifetime. When MFA enrolment completes mid-login as part of a mandatory-MFA policy, there's no "this device's session" yet to except, so that path revokes every session, matching how `changeExpiredPassword` already treats that same flow.
- New-device-login detection no longer silently no-ops when a client omits `deviceFingerprint` (it's `@IsOptional()` on `LoginDto`, and previously any client — or attacker — that didn't send one skipped the alert every time). New `AuthSessionsService.hasKnownIpUserAgent` is a fallback signal used only when there's no fingerprint: has this IP+user-agent pair shown up in this user's session history before? Deliberately independent of `isDeviceTrusted` — never skips MFA, only decides whether the alert email fires.
- New concurrent-session cap (`MAX_ACTIVE_SESSIONS_PER_USER = 10`) — `issueSessionToken` now evicts the least-recently-active session(s) first whenever a login would push the account over the cap, bounding how many sessions a slowly-leaked credential can accumulate.
- Admin impersonation (`AdminOrganisationsService.impersonate`) now emails the impersonated customer (`AuthMailService.sendAdminSupportAccess`) — already permission-gated, throttled, and audit-logged on FleetOS's side, but previously invisible to the account holder. Deliberately doesn't name the individual support staff member.
- **Deliberately out of scope**: step-up re-authentication before sensitive actions, and a real refresh-token architecture (rotation + reuse detection) — both genuine opportunities surfaced by this review, both architectural changes beyond "harden the existing layer," noted rather than silently dropped.
- Verified: `test/auth-security-policy.e2e-spec.ts` and `test/mfa.e2e-spec.ts` each gained session-revocation coverage; new `test/auth-session-hardening.e2e-spec.ts` covers the concurrent-session cap and `hasKnownIpUserAgent`; `test/admin-organisations.e2e-spec.ts`'s impersonation tests re-run clean as a regression check; full backend `jest`/`tsc`/`eslint` clean.

## 2026-07-31 — Auth/Billing Platform, Phase 9 (usage & feature limit depth)

A3 already resolved a company's plan tier and enforced its operator/asset count limits, but the entitlements response never reported *usage*, and two plan features declared since A3 — `forms`, `intelligence` — were never actually enforced at the API (only `warehouse` was).

- `Entitlements.usage` (`{operators, assets}`) is now always computed by `EntitlementsService.getUsage()` inside the same transaction that resolves the plan, regardless of whether `BILLING_ENFORCED` is even on; `assertWithinLimit` now reads from this same resolved usage instead of running its own separate count query.
- `FormTemplatesController`, `FormSubmissionsController`, `PredictiveMaintenanceController`, and `OperationalRecommendationsController` all gained `@RequireFeature(...)` — the same controller-level gate that has enforced `warehouse` since its own paywall phase. `OperationalRecommendationsController` stacks this alongside its pre-existing `@RequireFeatureFlag('operational_recommendations')` ops kill-switch. Verified first that both intelligence endpoints' frontend consumers already degrade gracefully on a 402 (an isolated Maintenance-page tab with its own retry; `AssignJobDialog` falling back to an empty recommendations list).
- **Deliberately out of scope**: no new limit dimensions (depots, customers, GPS devices, seats, …) — every plan tier has only ever limited operators and assets, and adding another dimension is a pricing decision, not a code decision.
- `fleethq-frontend`'s `BillingPage` now shows a proactive warning banner once a resource crosses 80% of its plan limit (`usage-warning.ts`'s `getUsageWarnings`/`usageWarningMessage`, kept out of the component file for the fast-refresh lint rule), and each plan card shows the company's own usage against that plan's limit (e.g. "9 of 10 assets") instead of only the bare limit.
- Verified: `test/entitlements.e2e-spec.ts` gained an asset-limit test (parity with the pre-existing operator-limit test) and a feature-gate test across Free/Starter/Pro tenants for both `forms` and `predictive-maintenance`; new `usage-warning.spec.ts` (6 tests) covers the warning threshold, unlimited/null limits, the `atLimit` boundary, and message phrasing; `tsc`/`eslint`/oxlint clean both repos. Browser-verified live: a Starter-plan company with 9 of 10 assets used shows "You're using 9 of 10 assets on your plan — approaching the limit." on `/billing`, with the Starter plan card reading "9 of 10 assets · 0 of 10 operators".

## 2026-07-31 — Auth/Billing Platform, Phase 8 (GST / Australian tax invoicing)

FleetOS still never generates its own invoices — this phase feeds Stripe the two pieces of Australian-specific data it needs to produce a compliant tax invoice once it is generating one, plus a config gate to keep it inert until a deployment is actually ready.

- `BillingService.createCustomer` attaches a company's ABN (`Company.abn`, collected since Phase 4) as a Stripe `au_abn` tax ID whenever a new Stripe Customer is created — unconditional, since attaching a known tax ID never needs Stripe Tax enabled. Known boundary: only covers customer-creation time, not retroactively for an ABN added later (the customer can add one themselves via the Stripe portal).
- New `STRIPE_TAX_ENABLED` config flag adds `automatic_tax`/`tax_id_collection` to Checkout Sessions — **deliberately gated**, because Stripe rejects those parameters as an API error unless Stripe Tax + an Australian GST registration are already configured in the Dashboard; shipping this always-on would have broken checkout everywhere that hasn't done that registration, including this repo's own dev/CI.
- Go-live checklist (`19-Billing/Billing_And_Subscriptions.md`) gained the GST-registration step this flag depends on.
- Verified: new `billing.service.spec.ts` (mocked-Stripe-client unit spec, mirroring `admin-billing.service.spec.ts`'s pattern) covers ABN-attached/ABN-absent/no-double-attach-for-existing-customer/tax-flag-on-vs-off; `test/billing.e2e-spec.ts`'s existing 13 tests re-run clean as a regression check; `tsc`/`eslint` clean.

## 2026-07-31 — Auth/Billing Platform, Phase 7 (customer self-service billing portal UI)

`fleethq-frontend`'s Billing page already existed (subscription badge, plan picker, Stripe portal button) — this phase closes the gap Phase 5/6 opened: the backend computed/emailed dunning-cycle detail since Phase 5, but the frontend `BillingStatus` type never picked up the three new fields, so the UI silently had no way to show them.

- `BillingStatus` (`src/api/types.ts`) gained `paymentFailureCount`/`lastPaymentFailedAt`/`nextPaymentAttemptAt`.
- The PAST_DUE banner went from one static sentence to reporting the real attempt count and either the actual next-retry date or that retries are exhausted, via a new pure `paymentFailureMessage()` helper (kept in its own module so `BillingPage.tsx` stays components-only for fast refresh) — plus its own "Update payment method" button so the CTA doesn't require scrolling down to the subscription box.
- **Fixed a stale link found along the way**: Phase 6's billing emails linked to `/settings/billing`, which doesn't exist — the real route is `/billing`. Corrected in `BillingMailService` and the two in-app notification `linkPath`s in `BillingService`.
- **Deliberately not built**: an in-app invoice/payment history list — `19-Billing/Billing_And_Subscriptions.md` already documents this as intentionally deferred to the Stripe-hosted Billing Portal; nothing about this phase's new data changes that calculus.
- Verified: new `payment-failure-message.spec.ts` (vitest) pins the three message states; frontend `tsc`/oxlint/vitest clean; the banner's actual rendering (badge, message, button visibility) was browser-verified — a real signed-up company moved to `PAST_DUE` with a failure count directly in Postgres (Stripe isn't configured in this dev environment), then screenshotted and asserted against at `/billing`.

## 2026-07-31 — Auth/Billing Platform, Phase 6 (billing & security notification emails)

Two sets of transactional emails (`22-Auth-Billing-Platform/Overview.md`), both through the existing `NotificationChannel` abstraction — no new email infrastructure.

- **Billing**: new `BillingMailService` (`sendPaymentFailed`/`sendPaymentRecovered`), wired into Phase 5's `invoice.payment_failed`/`invoice.paid` webhook handlers — fires after the DB update/in-app notification commits, fire-and-forget, to every `billing:manage` holder with an email on file. A new `NotificationsService.getPermissionHolders()` helper supplies the recipient list without duplicating `notifyPermissionInTx`'s membership query.
- **Security**: audited every security-relevant account event for whether it already emailed anyone, found four genuine gaps (all already had audit-log coverage — email was the only missing piece): password changed (fires from all three paths that end in a new hash — self-service change, completed reset, policy-forced expiry change), MFA enabled, MFA disabled (the higher-value alert — a classic takeover step), and account locked (reports the real computed unlock time).
- **Deliberately deferred**: new-passkey-registered has neither audit nor email today — closing it cleanly needs a new `AUDIT_ACTIONS` entry first, left for a later phase rather than folded in here. Admin-forced session revocation has no email hook because the feature itself doesn't exist (revocation is always self-service).
- **Complexity cleanup**: adding the lockout email pushed `AuthService.login()` over this repo's lint ceiling, so the lockout-handling block (audit record + email) was extracted into its own `handleAccountLocked` method.
- Verified: new unit specs (`auth-mail.service.spec.ts`, `billing-mail.service.spec.ts`) assert each email's recipient/subject/body against a stub channel — matching this codebase's existing boundary of unit-testing email content rather than asserting on it inside e2e; full backend `jest` suite re-run (542/543 — the one failure is the pre-existing `integrations.e2e-spec.ts` webhook-timeout flake, unrelated); `tsc`/`eslint` clean.

## 2026-07-31 — Auth/Billing Platform, Phase 5 (full Stripe webhook coverage + failed-payment handling)

`BillingService.handleWebhookEvent` (`22-Auth-Billing-Platform/Overview.md`) previously only handled `checkout.session.completed` and the three `customer.subscription.*` events — every invoice/payment event fell into a no-op default branch.

- **Two new webhook cases**: `invoice.payment_failed` increments a new `Company.paymentFailureCount`, stamps `lastPaymentFailedAt`/`nextPaymentAttemptAt` (Stripe's own retry schedule), and fans an in-app `billing.payment_failed` notification out to every `billing:manage` holder via the existing `NotificationsService` — no new notification infrastructure. `invoice.paid` resets the counter and notifies `billing.payment_recovered` **only** when this payment actually recovered the company from a prior failure, never on a routine renewal. Both resolve the company via `invoice.parent.subscription_details.metadata.fleetosCompanyId` — a Stripe-snapshotted field, no extra API round-trip needed.
- **Entitlements are unchanged by design**: `paymentFailureCount` is purely observational — `subscriptionStatus` going `PAST_DUE` (already handled before this phase) remains the only thing tied to plan entitlements, and `PAST_DUE` deliberately stays in `plans.ts`'s `ACTIVE_STATUSES` per the existing "billing informs, never hard-locks" v1 decision.
- **Complexity cleanup**: adding two more cases pushed `handleWebhookEvent` over this repo's own lint complexity ceiling, so every case body (including the pre-existing ones) was extracted into its own private method, keeping the dispatch switch itself trivial.
- **Deliberately deferred**: an actual payment-failed/recovered *email* (Phase 6, "Billing & security notification emails" — only the in-app notification exists so far); any billing-portal UI surfacing the new fields (Phase 7).
- **A pre-existing gap this phase's full-suite run caught**: `test/auth-completeness.e2e-spec.ts` still called `POST /v1/companies` without `acceptedTerms` — Phase 4 updated `companies.e2e-spec.ts`'s signup payloads but missed this other spec file, which started failing (400 instead of 201) the moment Phase 4 shipped. Unrelated to this phase's own webhook work, but caught and fixed here since it surfaced in this phase's full-suite verification pass.
- Verified: full backend `jest` suite (535/536 — the one failure is the pre-existing `integrations.e2e-spec.ts` webhook-timeout flake documented in Phase 1-3, confirmed unrelated by its own isolated re-run) including `billing.e2e-spec.ts` extended with 4 new cases (both events, repeated-failure counting, no-recovery-notification-on-routine-renewal, orphan-metadata no-ops); `tsc`/`eslint` clean.

## 2026-07-31 — Auth/Billing Platform, Phase 4 (registration depth + named role templates)

Two independent pieces of depth on `POST /v1/companies` provisioning (`22-Auth-Billing-Platform/Overview.md`).

- **Registration depth**: new `Company` columns `abn` (validated via a real ABR checksum algorithm, `IsAbn`), `industry`, `phone`, `fleetSizeEstimate` (all optional, editable after signup too), and a mandatory `termsAcceptedAt` — `SignupCompanyDto.acceptedTerms` must be exactly `true` (`@Equals(true)`), closing a real gap: the platform had actual ToS/Privacy Policy drafts but no record anyone had agreed to them.
- **Named role templates**: four new purpose-built system-template roles — Dispatcher, Fleet/Workshop Manager, Compliance Officer, Accounts — alongside the existing Administrator/Read Only/Driver trio. `provisionCompany` and `prisma/reconcile-permissions.ts` were both rewritten to loop over a single `ROLE_TEMPLATES` catalog instead of one hand-written block per role name.
- **Two real bugs caught by the rewrite**: `Role`'s `(companyId, name)` unique constraint has no exemption for archived rows or custom (non-system-template) roles, so (a) a company that archived its own copy of a template role, and (b) a company with an unrelated custom role that happens to share a new template's name (found 18 such cases in the dev database, from unrelated fixtures) both used to crash reconciliation trying to insert a duplicate. Fixed by checking for *any* role with that name before deciding a company is "missing" a template.
- **Also fixed**: the previous reconciliation script fetched every role's full permission set into memory and issued one `createMany` call *per role* — an N+1 pattern that stopped scaling once a fleet reaches thousands of tenants (concretely: this repo's own accumulated dev database went from a reconciliation run timing out to completing in seconds). Rewritten as a single batched `skipDuplicates: true` insert of every (role × permission) pair.
- **`fleethq-frontend`**: Administration → Company tab gained ABN/industry/phone/fleet-size fields.
- Verified: backend `jest` (all auth/companies/reconcile-permissions suites green, including new coverage for both bugs above); frontend `tsc`/`oxlint`/`vitest` clean.

## 2026-07-31 — Auth/Billing Platform, Phase 3 (password policy + per-org mandatory MFA)

Two company-level security policies (`22-Auth-Billing-Platform/Overview.md`), both checked at the one point a login resolves to a specific company membership.

- **Mandatory MFA + password expiry**: a new `company_security_settings` table (`mfaRequired`, `passwordExpiryDays`) checked by a new standalone, unit-tested `AuthPolicyGateService` from a shared `AuthService.finishLoginForMembership` tail — called from single-company login, the multi-company chooser, and two new policy-resume endpoints alike, so the policy applies identically no matter how many steps a login takes. A verified WebAuthn login still counts as MFA-equivalent (per Phase 2). The two checks can chain: finishing forced MFA enrolment re-runs the check, so a stale password on the same account still comes back `password_expired` rather than silently completing.
- **Password reuse prevention**: a new `PasswordPolicyService` + `user_password_history` table (capped at the 5 most recent hashes) — a fixed global rule rather than per-company-configurable, since a multi-company user has no non-arbitrary way to pick whose depth applies.
- **New endpoints**: `POST /v1/auth/mfa-setup/begin`+`/confirm`, `POST /v1/auth/password-expired/change` (all resume a blocked login via short-lived `PolicyActionPayload` JWTs), and `POST /v1/auth/change-password` (authenticated self-service change). New `GET`/`PUT /v1/security-settings` (gated on `security_policy:manage`) for an Administrator to set the company's own policy.
- **A genuine pre-existing bug caught along the way**: `selectCompany`'s membership lookup joined `User` through an RLS-scoped query that silently failed — the `users` table's RLS policy has no "visible to self" branch, only `companies`/`company_memberships` got that fix previously — because zero e2e tests had ever exercised that endpoint before this phase added one. Fixed by fetching `User` via `SystemPrismaService` instead (the pattern already used everywhere else in `auth.service.ts`), without touching the security-sensitive RLS policy itself.
- **`fleethq-frontend`**: `LoginPage` gained `mfa_setup_required`/`password_expired` states (and its `handleResult` router now also covers the multi-company chooser path, previously assuming `authenticated` was the only possible outcome). New `ChangePasswordCard` on the Profile page; `MfaCard` disables "Disable" when the company mandates MFA. New "Security" tab on the Administration page.
- Verified: backend `jest` (520/521 — same pre-existing `integrations.e2e-spec.ts` webhook-timeout flake noted in Phase 1/2, confirmed unrelated by re-running it against the pre-Phase-3 tree) plus a new `auth-security-policy.e2e-spec.ts` and `auth-policy-gate.service.spec.ts`; frontend `tsc`/`oxlint`/`vitest` clean.

## 2026-07-31 — Auth/Billing Platform, Phase 2 (magic link + social login + WebAuthn)

Three new first-factor login methods (`22-Auth-Billing-Platform/Overview.md`), all reusing Phase 1's device-trust/MFA gate — except WebAuthn, which deliberately bypasses it.

- **Magic link**: passwordless email login reusing the existing single-use `AuthToken` machinery with a new 15-minute `MAGIC_LINK` type. Still subject to the account's own MFA policy.
- **Social login (Google/Microsoft)**: sign-in only, never provisions accounts. `OidcVerifierService` does real cryptographic verification against each provider's live JWKS (`jose`) — never trusts a client-supplied claim. First login from a given external identity auto-links it by verified email; later logins resolve through a new `user_oauth_identities` table. Config-gated per provider — unconfigured providers are absent from `GET /v1/auth/providers` and refuse cleanly.
- **WebAuthn/passkeys**: usernameless (discoverable-credential) login via `@simplewebauthn/server`, backed by a new `user_webauthn_credentials` table. A verified passkey login is treated as already satisfying MFA and bypasses the account's TOTP policy — possession of the authenticator plus its own biometric/PIN check is itself multi-factor-equivalent.
- **`auth.service.ts`** (over the repo's 500-line lint ceiling after this work) split into `AuthService` + new `AuthSessionsService`/`AuthRecoveryService`, mirroring the earlier `JobStopsService` split. A new `LoginMethod` type threads through the MFA-challenge/pre-auth tokens into `LOGIN_SUCCEEDED` audit metadata.
- **`fleethq-frontend`**: `LoginPage` gained a provider-conditional button stack and a magic-link sub-form; new dependency-free `signInWithOidcPopup` helper (`src/lib/oauth-popup.ts`) drives both Google and Microsoft through one OIDC-implicit-flow popup code path rather than bespoke SDKs; new `MagicLinkPage`/`OAuthCallbackPage` routes; new `PasskeysCard` on the Profile page.
- Verified: backend `jest` (503/504 — same pre-existing `integrations.e2e-spec.ts` webhook-timeout flake as Phase 1, unrelated) including a from-scratch `VirtualAuthenticator` test helper that drives real ECDSA/CBOR through `@simplewebauthn/server`'s actual verification code; frontend `tsc`/`oxlint`/`vitest` clean; the full password → passkey-enrollment → passkey-login → magic-link-request round trip re-verified in a real headless Chrome session via CDP's `WebAuthn.addVirtualAuthenticator`. OAuth's positive path isn't covered by an automated test (would need a live IdP sandbox) — a known, documented boundary.

## 2026-07-31 — Auth/Billing Platform, Phase 1 (customer session & device management)

First phase of an 11-phase initiative (`22-Auth-Billing-Platform/Overview.md`) closing gaps toward a full enterprise-grade auth/billing/subscription platform. This phase mirrors the admin platform's own session model for customer `User` accounts.

- **New tables** `user_sessions` / `user_trusted_devices` (`prisma/migrations/20260731062654_customer_sessions_devices/`), granted only to the narrow `fleetos_auth` role, matching `users`/`auth_tokens`'s existing treatment.
- **`JwtPayload` gained a `sid` claim** naming the `UserSession` row backing the token; `JwtStrategy.validate()` now checks that row's `revokedAt`/`expiresAt` on every request, independent of the JWT's own signed expiry — the piece that makes "log out" or "revoke this session" take effect immediately instead of waiting out the token's lifetime.
- **`login()`** accepts an optional `deviceFingerprint` (skips the MFA challenge for a previously-trusted device; triggers a best-effort "new device" email otherwise) and `rememberMe` (extends the session/JWT lifetime from 12h to 30 days, threaded through the MFA-challenge and multi-company pre-auth tokens so it survives however many steps a login takes).
- **`verifyMfaChallenge()`** accepts `rememberDevice`, upserting a SHA-256-hashed `UserTrustedDevice` row on success.
- **New endpoints**: `GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/:id` (ownership-checked self-revoke), `POST /v1/auth/logout` (revokes the current token's session row).
- **`resetPassword()`** now also revokes every session row for that user, so `listSessions` doesn't keep showing devices that look active but can't actually be used (the `tokenVersion` bump already blocked them; this just keeps the UI honest).
- **`issueSessionToken()`** (shared with `CompaniesService.signup()` and `AdminOrganisationsService.impersonate()`) always creates a real session row now — a token minted without one would be rejected by `JwtStrategy` on first use.
- **`fleethq-frontend`**: `AuthProvider`/`api/auth.ts` gained a persisted per-browser device fingerprint, a "remember me" login checkbox, a "remember this device" MFA checkbox, a real `logout()` API call, and a new `SessionsCard` on the Profile page (list + revoke), mirroring the admin SPA's own equivalents.
- Verified: `tsc`/`eslint` clean on every touched file; full backend `jest` suite (494/495 passing — the one failure, `integrations.e2e-spec.ts`'s webhook-delivery test timing out, reproduces identically against the pre-change baseline in an isolated worktree, confirming it's a pre-existing flake unrelated to this change) plus targeted `vitest` runs on the frontend.

## 2026-07-31 — Repo split: admin/ → fleethq-frontend, driveros/ → fleethq-driveros (Phase 8)

On explicit direction: `driveros/` and `admin/` no longer live in this repo.

- **New repo [`fleethq-driveros`](https://github.com/dylanjkf/fleethq-driveros)**: `driveros/`'s content moved as-is (no functional changes). Own CI workflow, own README (updated to reference `fleethq-platform` for the backend/spec instead of a shared root). Lint/build/test re-verified clean in the new location before pushing.
- **`admin/` → `fleethq-frontend`, as a sibling app** (`fleethq-frontend/admin/`), deployed at `fleethq.online/admin` rather than a separate origin. `fleethq-frontend/vercel.json`'s `buildCommand` now builds both apps and stitches `admin`'s output into `dist/admin/`; its `rewrites` route `/admin/(.*)` to `admin`'s own `index.html` ahead of the office-dashboard's catch-all SPA rewrite (order matters — the catch-all would otherwise swallow every `/admin/*` request first). `admin/vite.config.ts` gained `base: '/admin/'`; `admin/src/app/router.tsx` passes `basename: import.meta.env.BASE_URL` to `createBrowserRouter` so client-side routing agrees with the subpath in dev and production alike. The app itself is unchanged: still its own `package.json`/build/bundle, still completely separate authentication from the customer SPA — only the deploy topology changed, not the isolation.
- **What stayed put**: the admin platform's backend (`api/src/admin-*`, `admin_*` tables, `fleetos_admin` role) is entirely unaffected — this repo remains the single source of truth for every admin permission, audit event, and guard. Only the two frontend clients relocated.
- Verified locally: both `fleethq-frontend`'s multi-app build command and the standalone `fleethq-driveros` repo build/lint/test clean. Not yet verified against a live Vercel deployment — flagged in both repos' docs as a spot-check for the first real deploy with this config.
- `FleetOS-Playbook/21-Admin-Platform/Overview.md`, this repo's root `README.md`, and `CLAUDE.md` updated throughout to reflect the new three-repo shape.

## 2026-07-31 — FleetHQ Administration Platform, Phase 7 (audit wiring, hardening, tests, docs)

Closed the real gaps a systematic audit of every `admin-*` service/controller found, rather than a rebuild — Phases 1-6 already did the large majority of this correctly.

- **Audit logging gaps, all in `admin-auth`**: MFA enrolment/disablement (`MFA_ENABLED`/`MFA_DISABLED`), backup-code consumption during a login challenge or a disable challenge (`MFA_BACKUP_CODE_USED`), `logout()` (`LOGOUT` — was silent, unlike the near-identical `revokeOwnSession()` right next to it), and "remember this device" (`DEVICE_TRUSTED`) were all unaudited security-relevant state changes. Five new `ADMIN_AUDIT_ACTIONS`, wired at the point each event actually completes.
- **`test/admin-route-permission-coverage.spec.ts` had a blind spot**: it verified every admin route carries a classification decorator (`@AdminAuthenticatedOnly()`/`@RequireAdminPermission()`) but never checked the `AdminJwtAuthGuard`/`AdminPermissionGuard` pair (`@AdminGuarded()`) was actually wired — since these guards are applied per-route rather than globally, a route that forgot `@AdminGuarded()` would have passed this test while being completely unauthenticated in production. Now asserts both guard classes are present via `Reflect.getMetadata(GUARDS_METADATA, ...)`.
- **Rate limiting**: only `admin-auth`'s login/MFA routes were tightly throttled; every Stripe billing mutation, organisation impersonation, and customer-account unlock/MFA-reset fell back to the app-wide 300/min default — far too loose for actions with real financial or account-takeover blast radius. New `ADMIN_SENSITIVE_ACTION_THROTTLE` (20/min, alongside the existing `BULK_THROTTLE`/`EXPORT_THROTTLE` presets) now gates all of them.
- **Tests**: `admin-auth.e2e-spec.ts` gained an `mfa/disable` test and a test proving all five new audit events land (read back through the real `GET /v1/admin/audit-log` endpoint). New `admin-billing.service.spec.ts` (11 tests, Stripe client mocked) covers the positive path of every one of the seven billing mutations plus the cross-tenant invoice-ownership rejection and both reinstate-subscription refusal branches — the e2e suite could only cover the "no Stripe object yet" refusal paths without a live Stripe test account.
- Deliberately not touched: CSRF (inapplicable — bearer token in `Authorization`, never a cookie) and CORS origin config for a deployed `admin/` (already supported by the existing `CORS_ALLOWED_ORIGINS` allowlist; adding the origin is a deployment step, not a code change).

## 2026-07-31 — FleetHQ Administration Platform, Phase 6 (admin frontend SPA)

**Phase 6 prereq**: `GET /v1/admin/audit-log` (`AdminAuditService.list()`, `audit_log:view`) — every prior phase already wrote to `admin_audit_logs` on every mutating action; this is the first endpoint that reads it back, paginated and filterable by action/entity/organisation/admin/date range. Also added `GET /v1/admin/organisations/:id/roles` so the existing "add a user to this org" support action can offer a real role picker instead of a raw UUID.

**Phase 6 — `admin/`, a new independently built/deployed React app** (sibling to `api/`/`driveros/`), the FleetHQ staff console. Built here rather than inside `fleethq-frontend` since that customer SPA is a separate, unattached repo — a fully separate deployable (origin, auth, bundle) is the correct shape anyway, matching the backend isolation Phase 1 already established.

- React 19 + Vite + TypeScript + Tailwind CSS 4 + TanStack Query + `react-router`, the same versions `driveros` uses minus everything offline/native-specific — desktop-only console, no offline requirement. `oxlint`, with its per-function complexity/line thresholds raised from `driveros`' mobile defaults for legitimately longer admin console pages.
- Two-step login (password → optional TOTP), a persisted device fingerprint for trusted-device MFA skip, and `useAuth().hasPermission(key)` gating every nav item/tab/action button on the exact permission key the backend route enforces — the UI's visible surface can never drift ahead of what a click would actually be allowed to do.
- One page per admin backend module from Phases 1–5 plus the Phase 6 prereq: Dashboard, Organisations (list + 4-tab detail: Overview/Billing/Notes/Feature Flags), Customer User detail, Announcements, Feature Flags, System Health, Fleet (cross-tenant search), Audit Log, Settings (MFA + sessions).
- Every empty/unconfigured state is honest, not a placeholder — e.g. the Dashboard's revenue card says "Billing is not configured on this deployment" rather than showing a fabricated `$0`, mirroring `AdminAnalyticsService`'s own `billingConfigured: false` from Phase 3; the Feature Flags empty state states the real fail-open behaviour.
- Impersonation shows the minted customer token in a dialog for the admin to copy manually (documented scope decision — `fleethq-frontend` is unattached, so a same-tab handoff isn't wired up), and the Fleet/Customer-User pages carry forward the backend's own cross-tenant exclusions (no credential config, no operator live location).
- `npx tsc -b`/`npx oxlint`/`npm run build` all clean. Manually browser-verified end to end with Playwright against a live local API + Postgres: full login, every page rendered with real data, a full write-path round trip (create → list → delete an announcement), and organisation-detail navigation — no console errors or failed requests.

## 2026-07-30 — FleetHQ Administration Platform, Phase 1 (schema + auth)

New `21-Admin-Platform/Overview.md`: FleetHQ staff's own internal tool for
operating the SaaS business (organisations, billing, support, system health),
completely separate from the customer-facing product — separate DB role,
separate JWT secret/strategy, separate frontend to come. Built on explicit
request; flagged against `00-Company/Commercial_Priority.md`'s standing
"finish the courier vertical first" directive before starting, per the
founder's decision to build the full spec.

**Phase 1 (this entry) — schema + auth foundation:**
- Seven new tables (`admin_permissions`, `admin_roles`, `admin_role_permissions`, `admin_users`, `admin_sessions`, `admin_trusted_devices`, `admin_login_attempts`, `admin_audit_logs`) plus a third database role, `fleetos_admin` (`BYPASSRLS`, narrowly-scoped explicit grants) alongside the existing `fleetos_app`/`fleetos_auth`.
- `src/admin-auth/`: login, TOTP MFA (reusing the customer platform's dependency-free `totp.ts` directly), trusted-device "remember me", 5-attempt/15-minute lockout, session listing/revocation, logout — mirroring every security property of the customer `AuthService`, adapted to FleetHQ staff accounts and signed under a completely separate `ADMIN_JWT_SECRET`/`admin-jwt` Passport strategy.
- Deny-by-default admin route classification (`AdminPermissionGuard`, `@AdminAuthenticatedOnly()`/`@RequireAdminPermission()`) — the same "unclassified route is denied, not silently allowed" contract as the customer API's `PermissionGuard`, enforced independently per admin route rather than via the global guard chain.
- `test/admin-auth.e2e-spec.ts`: login, lockout, unauthenticated/garbage-token rejection, full MFA enrol→challenge→verify flow, session revocation, logout — all against the real HTTP API and a live test database.

**Phase 1b — bootstrap tooling:**
- `prisma/reconcile-admin-permissions.ts`: seeds `admin_permissions` from the catalog and keeps two system-template `AdminRole`s in sync — Super Admin (every permission, always) and Support (a fixed view/support-ticket subset, never billing/feature-flag/staff management). Called from `prisma/seed.ts` (safe, credential-free, every environment) and standalone via `npm run admin:permissions:sync`.
- `scripts/bootstrap-admin.ts` (`npm run admin:bootstrap`): one-time creation of the first real `AdminUser`. Refuses to run if any admin account already exists; production requires explicit env vars and a password meeting the codebase's standard strength policy, with a dev-only fallback outside production — mirrors `prisma/seed.ts`'s "no default account in production" discipline.
- Fixed a real gap in `scripts/rotate-db-role-passwords.ts`: it rotated `fleetos_app`/`fleetos_auth` but not the new `fleetos_admin` role, which would otherwise have shipped to production still on its migration's hardcoded placeholder password. Now rotates all three via `NEW_ADMIN_ROLE_PASSWORD`.
- `test/reconcile-admin-permissions.spec.ts`: role creation, correct permission sets, drift repair, idempotency.

**Phase 2 — organisation + customer-user administration:**
- `src/admin-organisations/`: list/detail (with plan/trial/subscription status and asset/operator/attached-unit counts), suspend/restore, archive/unarchive, trial edit, impersonation (mints a real 30-minute customer session token via `AuthService.issueSessionToken`'s new `expiresIn` override — reusing the exact login signing path, refused against a suspended/archived org), and a support-scenario "add a user to this org" action.
- `src/admin-customer-users/`: cross-tenant user detail, disable/reactivate, unlock, MFA reset, and a "send password reset" action that delegates to the customer `AuthService.forgotPassword` (same no-enumeration behaviour as self-service).
- **Closed a real gap found while building this phase**: `Company.suspendedAt` existed since Phase 1's schema but nothing enforced it — a "suspended" organisation could still log in and use the product. `AuthService.completeLogin`/`selectCompany` now exclude a suspended company's memberships from login, and `JwtStrategy.validate()` now rejects an already-issued session token against a suspended/archived company on its very next request — the same "takes effect immediately, no re-login needed" guarantee the codebase already applies to `tokenVersion` revocation.
- New shared pieces: `AdminGuarded()` decorator (collapses the two guards every authenticated admin route needs), `AdminActionContext` interface (shared across admin feature modules), and `test/admin-route-permission-coverage.spec.ts` (the admin-platform equivalent of the customer route-coverage build check).
- `test/admin-organisations.e2e-spec.ts` + `test/admin-customer-users.e2e-spec.ts`: 15 tests covering every action above, including the suspension-enforcement fix, against the real HTTP API.

**Phase 3 — executive dashboard (real aggregate data):**
- `src/admin-analytics/` (`/v1/admin/analytics/*`): organisation/user/fleet counts, subscription-status breakdown, an active-trials count, a daily-signups time series, and a trials-expiring-soon follow-up list — computed live on every request from the same `fleetos_admin` connection every other admin module uses. No new database grants needed; Phase 1's existing read access to `companies`/`users`/`assets`/`operators` already covered it.
- **Revenue (MRR/ARR)** computed from the small, fixed set of configured tier price ids — at most 3 Stripe API calls total (`BillingService.getPriceUnitAmounts`, a new stateless method on the existing customer `BillingService`), never one per subscribed company; annual prices normalised to monthly before summing. Honestly reports `billingConfigured: false` (all revenue fields `null`) rather than fabricating a number when Stripe isn't configured, matching `BillingService`'s existing tolerance everywhere else.
- **Churn** is a documented best-effort proxy (count of currently-CANCELED companies updated in the last 30 days — `Company` has no `cancelledAt` column) reported as a plain count, not a percentage, since a true rate would need historical data this schema doesn't track.
- Deliberately reports only metrics this codebase can actually produce — no fabricated infrastructure numbers (queue depth, cache hit rate) for systems that don't exist here.
- `src/admin-analytics/admin-analytics.service.spec.ts`: focused unit coverage for the MRR arithmetic (monthly/annual normalisation, multi-tier summation, a failed price lookup handled gracefully) with Stripe/DB mocked, since the configured-Stripe path can't be exercised end-to-end without real network access. `test/admin-analytics.e2e-spec.ts`: real aggregate counts, the unconfigured-billing path, signups, trials-expiring, and query validation against the real HTTP API.

**Phase 4 — billing operations on top of the existing Stripe integration:**
- `src/admin-billing/` (`/v1/admin/organisations/:companyId/billing/*`, nested under organisations per the Phase 2 company-scoped-action convention): status, invoice listing, refund, coupon application, ad hoc manual invoices, credit notes, payment retry, and cancel/reinstate subscription — all layered directly on the existing customer `BillingService`/Stripe client (a new `getStripeClient()` accessor), not a second SDK instance or a separate billing data model.
- **`Company.subscriptionStatus`/`planPriceId` stay exclusively the webhook's responsibility** even for these admin writes: every admin billing method only ever reads/acts on Stripe objects and the two Stripe id columns on `Company` — an admin action changes Stripe's state, and the next webhook delivery (not the admin request itself) is what reflects that back onto the `Company` row, exactly as it already works for customer-initiated changes.
- **Cross-tenant safety**: invoice-scoped actions (refund/credit-note/retry-payment) resolve the invoice via Stripe and verify its `customer` matches the target company's `stripeCustomerId` before acting, since the route only scopes by `companyId` in the URL.
- **Real Stripe API-shape gotcha caught by direct `.d.ts` inspection**: this SDK version (22.3.2) moved `payment_intent` off `Invoice` itself onto the invoice's `payments` list (`Stripe.InvoicePayment[]`) — a refund now resolves its target from the invoice's paid/default `InvoicePayment` entry rather than a since-removed `invoice.payment_intent` field.
- Every mutation is audit-logged (7 new `ADMIN_AUDIT_ACTIONS`), and every unconfigured/missing-Stripe-object case fails with a specific error code (`NO_STRIPE_CUSTOMER`, `NO_STRIPE_SUBSCRIPTION`, `INVOICE_NOT_FOUND`, `SUBSCRIPTION_ALREADY_CANCELED`, etc.) rather than a generic 500.
- `test/admin-billing.e2e-spec.ts`: 13 tests — auth/permission rejection, DTO validation, and the `NO_STRIPE_CUSTOMER`/`NO_STRIPE_SUBSCRIPTION` refusal path for every mutating route. Exercising a real Stripe call needs a live test account this offline suite doesn't have, the same documented constraint `test/billing.e2e-spec.ts` already carries.

**Phase 5 — support tools, feature flags, system health, cross-tenant fleet views:**
- `src/admin-support/`: a customer-visible announcement banner (`Announcement` — deliberately NOT `admin_`-prefixed/RLS'd, since it's meant to be read by the customer stack, unlike everything else in this section) plus staff-internal notes about an organisation (`admin_organisation_notes` — the opposite: never readable by customers). New customer route `GET /v1/announcements/active`. A "resend verification email" support action added to the existing `AdminCustomerUsersController`.
- `src/feature-flags/` + `src/admin-feature-flags/`: admin-managed rollout flags (`FeatureFlag` global default + per-company `FeatureFlagOverride`, RLS'd like any other tenant table) evaluated by a new `FeatureFlagGuard`/`@RequireFeatureFlag`, modelled on the existing billing-entitlement `FeatureGuard` but answering a different question. **Not a scaffold**: `operational-recommendations`'s routes are actually gated on it, and the test suite proves disabling the flag returns a real `403` and a per-company override actually restores access. A missing flag key fails open (enabled), so creating a flag is always safe.
- `src/admin-system/`: real DB-connectivity/uptime/version diagnostics (`GET /v1/admin/system/health`) — no fabricated infra numbers, matching Phase 3's honesty standard for the same reason.
- `src/admin-fleet/`: cross-tenant read-only browsing of assets/operators/integration connections for support lookups ("who owns this VIN/rego"). New grant on `integration_connections` only — never `integration_credentials` (encrypted secrets) — and operator live location is deliberately excluded (Privacy Act personal information with no support justification).
- 22 new tests across `test/admin-support.e2e-spec.ts`, `test/admin-feature-flags.e2e-spec.ts`, `test/admin-system.e2e-spec.ts`, `test/admin-fleet.e2e-spec.ts`.

Not yet built: FleetHQ staff account management (creating admins other than via the bootstrap script) and the admin frontend — see the Overview doc's status table.

## 2026-07-28 — Live map removal, configurable barcode scanning, Integration Hub foundation

**Portability + dev-experience fixes (merged separately, noted here for completeness):**
- Six standalone scripts (`seed-enterprise-company.ts`, `seed-demo-company.ts`, `seed-load-test-data.ts`, `rotate-db-role-passwords.ts`, `prisma/seed.ts`, `prisma/reconcile-permissions.ts`) constructed `PrismaClient` directly and relied on `@prisma/client`'s CWD-relative auto-`.env`-load, which only works if the process's working directory happens to be `apps/api` — fragile across invocation styles/machines. New `apps/api/scripts/load-env.ts` resolves `.env` from the script's own file location instead.
- `apps/fleethq`/`apps/driveros`'s offline service worker was registering in `vite dev` too — dev serves unhashed module URLs whose content changes without the URL changing, so the worker kept serving a stale cached module from a previous dev session ("Failed to fetch dynamically imported module" on first navigation to a route in a new session). Now PROD-only; dev actively unregisters/clears a pre-fix session's leftover worker+cache.

**Live map removed** from FleetHQ's navigation (product decision): the standalone `/live-map` and `/live-map/tv` (TV/kiosk) pages, their nav entry, and routes are gone. The dispatch board's own "Live driver locations" panel — a plain list with a link-out to Google Maps, not an embedded tile map — is unaffected, as is the underlying `/v1/locations` API (still used by that panel and by DriverOS's own location reporting).

**Configurable barcode scanning** (`01-Product/Barcode_Scanning.md`): office staff can scan consignments into a run instead of typing every field by hand. Admin-configurable searchable fields, field-mapping rules, and scan mode (database lookup / encoded barcode / hybrid) — extensible without code changes, from a new Barcode Scanning tab in Admin Settings. USB/Bluetooth keyboard-wedge scanners and manual entry work out of the box; a camera-scan option appears wherever the browser supports the native `BarcodeDetector` API. Duplicate protection (blocks re-adding a consignment already on the run or belonging to a cancelled job, highlighting the existing record) and a graceful "barcode not recognised" path (search manually / create new / ignore) — never a silent failure. New permission `barcode_config:manage`.

**Integration Hub foundation** (`10-Integrations/Integration_Hub.md`): a generic, plugin-shaped connector framework so FleetHQ — a TMS, not a WMS — can connect to whatever ERP/warehouse/accounting system a customer already runs, without bespoke per-vendor engineering. Built: an encrypted credential vault (AES-256-GCM, greenfield in this codebase), a universal field-mapping engine (unlimited external-field → FleetHQ-field rules with transforms), a sync engine (manual + scheduled, reusing the existing bulk-import framework's per-entity create paths so a synced row is validated identically to a manually-created one, plus a dead-letter retry queue), a webhook manager (incoming + outgoing, HMAC-signed), a sync dashboard, and an error centre — plus three reference connectors: CSV/Excel import-export, a generic REST poller, and a generic incoming webhook receiver. New permissions `integrations:view`/`integrations:manage`. Deliberately **not** built: bespoke SAP/Oracle/NetSuite/Dynamics/Pronto/Cin7/Fishbowl/Odoo clients, EDI, SFTP/ODBC, GraphQL/SOAP — each is a real, separate project against a specific customer's actual system, and the plugin architecture doesn't block adding them later. Note: this is enterprise-integration scope, adjacent to but not squarely inside the standing "finish the delivery-fleet courier vertical first" commercial priority (`00-Company/Commercial_Priority.md`) — built on explicit request, flagged here per that doc's own instruction to say so rather than build quietly off-priority.

## 2026-07-23 — Premium/enterprise upgrade (in progress)

Working from a fresh 8-lane CTO-level audit (architecture, enterprise-scale, security/compliance, premium UX, data model, testing/observability, DriverOS offline, product-gap vs competitors + Australian verticals) toward a premium, enterprise-ready Australian fleet product. Landing in reviewable commits.

**Wave S — UX polish + offline integrity + audit ergonomics (founder-requested):**

Skeleton loaders, caching, optimistic UI, "make logging/auditing easy", "make
offline sync work perfectly", and strict input validation. An audit found most
of this already in place; this wave closes the real gaps, in verified commits:

- **Offline sync integrity (data-safety).** The DriverOS outbox was durable and
  FIFO but four queued mutation types had no replay idempotency, so a "flaky
  success" (request landed, response lost) created duplicates on retry. Fuel
  entries, fault reports and messages now carry a client-generated
  `clientRequestId`, deduplicated server-side on a new nullable per-company
  unique column (migration `20260726230000`) — a duplicate fuel entry can no
  longer inflate the office spend rollup, a duplicate fault can't open a second
  workshop job. Shift start/end (no create-id to dedup) now declare
  `idempotentReplayCodes`, so a replay returning `SHIFT_ALREADY_ACTIVE` /
  `SHIFT_NOT_ACTIVE` is treated as the success it is instead of dead-lettering a
  successful action with a false red-banner failure.
- **Caching.** DriverOS React Query was `staleTime: 0` (refetch on every screen
  change — wasteful on a flaky tablet link); now 30s stale + 10m cache. Both
  apps disable `refetchOnWindowFocus` (the live views poll on their own).
- **Auditing "easy & straightforward".** Built the missing FleetHQ **Audit Log**
  page (`/audit-log`, nav-gated by `audit:view`, which was previously an orphaned
  permission — API existed, no screen did), with filters for action/outcome/
  actor/target/date-range. Type-locked `AUDIT_ACTIONS` (a typo or ad-hoc action
  string now fails to compile) and added the investigation filters to
  `GET /v1/audit-logs`.
- **Skeleton loaders.** Ported a Skeleton primitive to DriverOS (it had none —
  every screen showed plain "Loading…") and applied content-shaped skeletons to
  Today, Checklist list + runner, Forms, Messages, Notifications and Glovebox;
  fixed the FleetHQ Messages thread pane.
- **Optimistic UI.** Notification read-state (both apps), attached-unit
  hitch/unhitch, and notification-preference toggles now update instantly with
  rollback on error (onMutate → snapshot → invalidate on settle).
- **Strict input validation.** The global `ValidationPipe` already enforced
  schema/type checks + rejection of unexpected fields (`whitelist` +
  `forbidNonWhitelisted`); added the missing length caps on the unauthenticated/
  auth surface (pre-auth + MFA tokens, reset/verify tokens, push endpoint/keys,
  link-existing-user username) and a `react/no-danger` lint ban (from Wave R).

**Wave R — security-hardening pass (founder-requested 10-point review):**

A founder-requested sweep of ten security controls (RLS, rate limiting, secret
handling, env hygiene, input validation, DB-access lockdown, route auth, error
leakage, admin/debug endpoints, intrusion logging). A three-angle audit found
**most were already in place and strong** — RLS on all 52 tenant tables with a
cross-tenant e2e test; 3-role least-privilege Postgres with forced TLS; a global
`ValidationPipe` (whitelist + forbidNonWhitelisted) plus magic-byte upload
sniffing; JWT deny-by-default auth; a global exception filter that never leaks
stack traces or Prisma internals; no Swagger/GraphQL/debug endpoints; secrets
server-side only (frontends ship nothing but a public Sentry DSN); and an audit
trail with CloudWatch brute-force/lockout alarms and a WAF. This wave closes the
real gaps found:

- **Authorization is now deny-by-default.** `PermissionGuard` previously
  *allowed* any route that forgot its `@RequirePermission` (reachable by any
  authenticated user, though still RLS-scoped to their tenant). Now a route must
  be explicitly classified as one of `@Public()`, `@RequirePermission(...)`, or
  the new `@AuthenticatedOnly()` — anything else is denied. The 20 legitimately
  permission-free routes (own identity/MFA, own notifications & preferences, own
  push subscription, own dashboard layout, own fatigue status, company
  entitlements, support info, universal search, inspection submit) are now
  explicitly `@AuthenticatedOnly()`, so behaviour is unchanged — only a *future*
  forgotten decorator fails closed. A new `route-permission-coverage` test
  enforces exactly-one classification per route at build time.
- **Permission denials are now in the tenant audit log.** Every 403 was logged
  to stdout only; it's now also written to `AuditLog` (`access.permission_denied`,
  best-effort) so a tenant admin can see authorization probing / IDOR sweeps in
  `GET /v1/audit-logs`.
- **Intrusion alarms for the high-value signals.** New CloudWatch metric filters
  + alarms for a burst of permission denials (authz probing), privilege changes
  (role/permission edits, user role changes, access grants/revocations), and
  personal-data exports/erasures (bulk exfiltration). Because those audit events
  were DB-only, `AuditService` now also mirrors them to stdout so the alarms can
  see them. Added **AWS GuardDuty** (account-level anomaly detection, findings
  routed to the alerts topic) and a multi-region, log-file-validated **CloudTrail**
  (tamper-evident control-plane audit) — the "know if someone is hacking me at
  the AWS layer" coverage the app logs can't provide.
- **Per-route + per-session rate limiting.** Expensive/abusable authenticated
  routes (bulk imports, bulk job create, message broadcast, attachment upload,
  GPS device registration, data export/erasure) now carry stricter `@Throttle`
  limits on top of the global 300/min. A custom `ScopedThrottlerGuard` keys
  buckets by session (bearer-token hash) instead of raw IP, so many DriverOS
  devices behind one depot's shared WiFi no longer 429 each other when their
  offline outboxes flush. `LoginDto` gained length caps.
- **Frontend hardening.** Both frontend `.gitignore`s now ignore `.env*` (keeping
  only `.env.example`) — they previously only ignored `*.local`. `react/no-danger`
  is now an oxlint error in both apps: defence-in-depth so `dangerouslySetInnerHTML`
  can never be introduced (today there is none; user text is React-escaped and the
  Markdown renderer is element-based).

Known follow-up (documented, not changed here to avoid a regression): the API
sits behind CloudFront→ALB but the ALB security group is open to the internet,
so Express `trust proxy` stays at `1` — raising it to trust the CloudFront hop
would let a direct-to-ALB request spoof its client IP. The correct fix is to
lock the ALB security group to CloudFront first, then increase the trust depth.
Per-IP login throttling is otherwise unaffected for direct traffic.

**Wave Q — dispatch/live-map polish + first-visit tab error (founder-requested):**

- **Removed the embedded live map from the Dispatch board.** The rectangular
  mini-map tile in the Dispatch "Live driver locations" panel
  (`features/dispatch/FleetMap.tsx`, now deleted) is gone; the panel keeps its
  textual per-driver location cards (each still links out to maps). The full
  map lives on the dedicated **Live Map** page, so it's no longer duplicated on
  the dispatch board.
- **Live Map page redesign.** Softer framing (rounded panel, ring + shadow) in
  place of the flat rectangle, a floating **legend** explaining the marker
  colours (Live / Recent / Stale — now a single shared `statusOf` used by both
  markers and roster), a header summary strip showing on-shift vs total live,
  and refined roster cards with a status dot matching each marker.
- **"Trucks in the water" on the demo map — fixed.** The Titan Freight enterprise
  seed scattered driver positions ±0.25° around coastal CBD centres, which
  dropped some markers into the harbour/bay/ocean. Hub centres are now biased
  inland and the scatter tightened to ~±0.07° (a shared `scatterNearHub`
  helper), so simulated trucks stay on land. The re-run path now **re-scatters**
  as well as re-stamps, so re-running `seed:enterprise` repairs an
  already-seeded fleet. (Cosmetic to the demo dataset only — real GPS positions
  come from driver phones and are accurate.)
- **First-visit tab error, fixed.** Navigating to a route not yet opened this
  session could throw "Failed to fetch dynamically imported module" (refreshing
  cleared it) when a stale service worker still held the previous app shell
  after a new deploy. `lazyPages.ts` now wraps every code-split page in a
  `lazyWithRetry` guard that force-reloads once (per chunk, per session) on an
  import failure to fetch the current shell, then proceeds — so the user no
  longer sees the error. A genuinely unreachable chunk still surfaces normally.
- **Compliance position:** "Roadworthys current" bar relabelled "Roadworthy
  current".

**Wave P — enterprise simulation seed:**

A new `npm run seed:enterprise` (`scripts/seed-enterprise-company.ts`) provisions a
full-scale demo tenant, "Titan Freight Group", so the product can be shown at
real enterprise volume: **200 assets, 220 attached units, 190 drivers (each with
a DriverOS login on the seeded Driver role), ~10,400 delivery jobs and ~46,000
stops across a full year, ~11,000 pre-start inspections, 1,000 completed forms,
a full office↔driver message history, compliance documents (rego/insurance/
roadworthy per truck, licence per driver — mostly current, some expiring/expired
so the Compliance position bars read realistically), and a live position on every
driver so the whole fleet shows on the Live Map immediately**. Runs as the
schema-owning role with batched `createMany` (~40s for ~70k rows); it's additive
(a separate tenant, `admin@titan` / dev password), bails if the company already
exists, and on a re-run instead re-stamps every driver's position to now so the
map re-populates (live positions age out after 12h).

**Wave O — remove DriverOS voice commands + ungate checklist submission (founder-requested):**

- **Removed AI Voice commands from DriverOS** — the floating voice trigger and
  its command engine (`features/voice/*`, `lib/voice-*`) are gone. Nothing else
  depended on it; the Fault Report screen's optional `title` query param still
  works, it's just no longer set by voice.
- **Anyone signed in can submit a checklist (inspection), regardless of role** —
  `POST /checklist-submissions` is no longer gated by `checklists:submit`
  (completing a pre-start is a core field action). The JWT auth guard still
  requires a valid login, and template management / viewing submissions stay
  permission-gated. The `checklists:submit` catalog entry is retained but
  dormant.
- Verified: API suite incl. the rewritten checklist route-permission e2e green,
  DriverOS build + tests green.

**Wave N — DriverOS messaging + inspection fixes and depth (founder-reported):**

- **Drivers can message the office again** — the root cause was that a driver's
  role had `messages:view` but not `messages:send` (only Administrator carried
  send), so a reply 403'd before it was ever saved. There was no ready-made
  driver role, so the office hand-built one and it was easy to miss. Added a
  seeded **"Driver" system role** bundling the DriverOS field permissions
  (inspections/forms submit, deliveries, location, shifts, fuel, and messaging).
  Provisioning a new company creates it; `permissions:sync` back-fills it into
  existing companies. **Action for existing fleets:** assign the new "Driver"
  role to your driver logins.
- **"Message all" broadcast** — a new `messages:broadcast` permission + `POST
  /messages/broadcast` sends one office message into every operator's thread at
  once (each driver sees it as a normal message). Surfaced as a "Message all"
  action on the FleetHQ Messages page.
- **Inspection items can take written answers** — a new `text` item type: the
  operator types a response instead of pass/fail. Rendered as an always-visible
  text box on DriverOS and shown as the answer in the FleetHQ submission view.
- **Assign an inspection to specific assets** — a new
  `checklist_template_assignments` join table (RLS-scoped) lets the office
  assign a template to particular assets once; it then applies to those assets
  every day, on top of the asset-class rule. Set via a multi-select on the
  template form; the DriverOS "which inspection applies here" query now includes
  directly-assigned templates.
- **DriverOS inspections no longer hang on "Loading…"** — the runner gated its
  whole UI on an IndexedDB draft read that had no error path, so a blocked PWA
  upgrade or unavailable storage stranded it forever. The effect now always
  reveals the checklist (fresh run on failure), and the DB open gained
  blocked/blocking/terminated handlers plus a reset-on-failure so one bad open
  can't poison the session.
- **CI:** made the `dependency-audit` job resilient to npm's retiring quick-audit
  endpoint (parse the JSON report; a registry error is retried then treated as
  inconclusive rather than a false red).
- Verified: full API suite incl. new broadcast/text-item/assignment e2e green,
  both frontends lint/build/test green, permission parity holds (94).

**Wave M — founder-requested compliance position, nav trims + Checklists → Inspections rename:**

- **Compliance position widget rebuilt as six live currency bars** — one small
  0–100% horizontal bar per factor, each showing "X of Y" for its own
  denominator: today's pre-start inspections (of active assets), driver licences
  current (of active operators), deliveries completed successfully (of
  delivered + failed stops), and roadworthy / insurance / registration currency
  (each of active assets). Every figure is recomputed on read from a new
  `GET /compliance-documents/position` (compliance:view), and the widget
  refetches on a 30s interval + on window focus, so the bars track changes
  automatically. Bar colours follow the company's own green/amber thresholds
  (analytics:manage); pre-start keeps its analytics override. Nothing is faked —
  each rate is a direct count over real tenant data.
- **Warehouse removed from the UI** — the nav entry and `/warehouse` route are
  gone (founder is redesigning it). The backend, permissions and pages remain in
  the tree, just unreachable, so re-enabling later is a nav + route line.
- **Fleet Intelligence (AI) removed from the UI** — nav entry and `/ai` route
  removed for now, same reversible approach.
- **GPS trackers removed — phone GPS only** — the Fleet "GPS trackers" tab is
  gone, and both the Live Map and the TV/wall-display map now plot only
  DriverOS phone positions (hardware-tracker markers, roster rows and copy
  removed). The ingest API and device records are untouched.
- **"Checklists" renamed to "Inspections"** across FleetHQ (nav, page, empty
  states, table headers, toasts) and DriverOS (pre-start screen, submit button,
  status bar). Routes, API paths and permission keys stay `checklists` — a
  label-only rename, no data migration.
- Verified: full API suite incl. new compliance-position e2e (green), both
  frontends lint/build/test green, permission parity holds (93).

**Wave K — dashboard "morning operations view" (4 new widgets):**

The dashboard gained the operations-overview panels from the product design —
built as real, permission-gated, reorderable widgets in the existing
customizable grid, every number wired to live data (nothing hardcoded):

- **Compliance position** — the panel that prompted this. Two real bars:
  document currency (valid / expiring-soon / expired) from a new
  `GET /compliance-documents/summary`, and today's pre-start inspection
  completion from `GET /checklist-status/today`. The mockup's "site inductions"
  bar was **dropped, not faked** — FleetOS has no induction data.
- **Expiring soon** — the next compliance documents to lapse, from the existing
  expiry-ordered list, with days-remaining derived per item.
- **Operations snapshot** — Assets active · In workshop · Services due · Open
  defects, from a new `GET /dashboard/metrics` (+ maintenance plans). "In
  workshop" = assets with an open maintenance job (the honest proxy for
  "off road", since Asset carries no status field by design); "Open defects" =
  driver-raised open jobs. **Day-over-day deltas (+6 / −3) were omitted** —
  there's no historical snapshot to compare against, so they'd be invented.
- **Fleet utilisation** — a live point-in-time gauge (assets on an active job ÷
  active assets), plus a **real accumulated day-by-day trend** (see next entry).
- New endpoints: `GET /compliance-documents/summary`, `GET /dashboard/metrics`
  (no new permissions — reuse compliance:view / assets:view). Verified: full API
  suite (371) + both frontends lint/build/test green, permission parity holds.

**Wave L — analytics controls (a role that can adjust/reset the percentages):**

A new granular permission, **`analytics:manage`** (Administration category, auto-
granted to the Administrator system role), unlocks an **Administration → Analytics**
tab with four controls over the dashboard percentages. Everything stays honest:
overrides are visibly marked and every change is written to the security audit log.

- **Targets & thresholds** — a company sets its own utilisation target (the
  dashboard's target line), compliance target, and the green/amber cut-offs that
  colour the bars, with "reset to defaults". Stored in a new `analytics_settings`
  row (absent = platform defaults 80/95/95/80).
- **Manual overrides** — replace a live percentage (fleet utilisation / compliance-
  current / pre-start) with a hand-set figure "for any reason". The dashboard shows
  the value with a "Manually adjusted" marker, the note, and who set it — never
  mistakable for the raw computed number. `analytics_overrides` table, one active
  per (company, metric); clearing restores the computed value.
- **Exclude data points** — drop an unrepresentative day (e.g. a test job inflated
  it) from the utilisation trend and the vs-yesterday delta. A correction to the
  inputs (an `excluded` flag on the day's snapshot; the computed figure recovers),
  not an override of the output.
- **Reset accumulated history** — clear the utilisation snapshots so the trend +
  deltas rebuild from now (fleet restructure, skewed period), behind a destructive
  confirm; live figures unaffected.
- New endpoints under `/v1/analytics/*` (read gated `assets:view` so the widgets
  can consume targets/overrides; all writes gated `analytics:manage`), each
  mutation `AuditService`-logged (`analytics.settings_updated`, `.override_set`,
  `.override_cleared`, `.history_reset`, `.day_excluded`, …). The compliance and
  utilisation widgets now honour the thresholds, targets (a dashed target line on
  the sparkline), and overrides. RLS + runtime GRANTs on both new tables.
- Verified: 376 API tests (incl. a new analytics suite covering targets/overrides/
  exclusion/reset + read-vs-manage gating + the audit trail), both frontends
  lint/build/test green, permission parity holds at **93**.

**Wave K++ — real "vs yesterday" KPI deltas (no fabricated baseline):**

The Operations-snapshot tiles now carry the day-over-day deltas from the design
(+6 / −3), computed against genuine history rather than invented:

- The daily snapshot row (`utilisation_snapshots`) was extended to also
  accumulate In-workshop, Open-defects and Services-due counts (alongside the
  utilisation numbers), so each KPI has a real prior-day average to diff against.
- `GET /v1/dashboard/metrics` now also returns `servicesDue`, a `deltas` object
  (current value − the most recent prior-day snapshot average, for Assets active
  / In workshop / Services due / Open defects) and `comparedTo` (the day the
  delta is measured against). `deltas` is **null until a prior day exists** — a
  brand-new company sees no chip rather than a fake "+0", and the widget says
  "day-over-day change appears once a prior day is recorded."
- Each tile shows a signed chip coloured by whether the move is good news
  (a rise in Assets active is green; a rise in Open defects is red). Services due
  moved into the metrics endpoint, so the snapshot widget is now one call.
- Verified: 373 API tests (a new one seeds a prior-day snapshot and asserts the
  exact deltas), both frontends green.

**Wave K+ — real fleet-utilisation trend (no fabricated history):**

The utilisation widget's mockup showed a multi-day trend line, which was
deliberately not faked in Wave K because FleetOS stored no usage history. It now
records that history honestly and plots it:

- New `utilisation_snapshots` table — one accumulating row per company per day
  (busySum / activeSum / sampleCount, RLS + runtime GRANT like every tenant
  table). The leader-elected scheduler folds the current busy/active reading into
  today's row each tick (default every 4h, `SCHEDULER_UTILISATION_INTERVAL_MS`),
  so the day's figure is a real weighted average, not one arbitrary sample.
- `GET /v1/dashboard/utilisation-trend?days=N` (assets:view) returns one point
  per day that has samples — days with none are simply absent, never back-filled
  with an invented number.
- The Fleet utilisation widget now renders a dependency-free SVG area sparkline
  of the trend beneath the live gauge (same "no charting library" approach as the
  Impact page); a new company sees "the daily trend builds up over the coming
  days" until there are two real days to plot.
- Verified: 372 API tests (a new one asserts two samples fold into one day as a
  50% weighted average and serve as a trend point), both frontends green.

**Wave J3 — FleetHQ: complete half-wired features + honest failure states:**

The completeness audit surfaced a class of user-visible gaps where a page had a
button that led nowhere, silently swallowed a data field, or showed a reassuring
"all clear"/"nothing here" when the real cause was a *failed* request. All fixed:

- **Office form runner (biggest gap).** The Forms builder could create templates
  targeted at "FleetHQ (office)" or "both apps", but only DriverOS had a way to
  *fill one in* — an office template was un-runnable. FleetHQ now has a real form
  runner (`FormRunnerDialog`): a "Fill in" action on every office-fillable
  template, same conditional-visibility and required-field rules as the DriverOS
  runner, submitting through the shared `POST /form-submissions`. asset_ref /
  operator_ref fields become directory pickers (FleetHQ has the full directory,
  unlike DriverOS where they auto-resolve from job context).
- **Stock-adjustment reason no longer vanishes.** Warehouse "adjust quantity"
  accepted a reason all the way from the dialog's API call to the DTO, but the
  service discarded it. Now every adjustment lands in a new append-only
  `stock_adjustments` ledger (delta, resulting quantity, reason, actor) — RLS +
  runtime GRANT like every tenant table — and the adjust drawer both collects a
  reason and shows recent history. `GET /warehouse/stock/:id/adjustments`.
- **Email-verification dead end fixed.** An expired verification link told users
  to "request a new one from your profile" — a control that didn't exist. It now
  offers a real, enumeration-safe resend form inline (username/email → new link).
- **Failed queries stop lying.** AIPage, DashboardPage (widget layout), the Users
  role picker, Maintenance schedules, and the notifications-digest tab all treated
  a fetch error as empty data — showing "All clear" / "Nothing deployed" / an
  empty role list when the truth was "couldn't load". Each now distinguishes error
  from empty and offers a retry.
- **Smaller wiring fixes:** warehouse import button now reflects a real pending
  flag (a double-click no longer imports every row twice); notification-digest
  toast reports the true emailable-recipient count (+ how many were reached in-app
  only); live-map roster now lists standalone GPS trackers, not just driver
  devices; applying an address book now records DEPOT/CUSTOMER timeline events with
  the actor (was created raw, untraceable); a one-off maintenance plan can be added
  and a deployed plan removed from the schedules tab.
- Verified: warehouse/forms/glovebox/POD/address-book e2e green, API + both
  frontends lint/build/test clean, permission parity holds (92), API reference
  regenerated (257 routes).

**Wave J2 — dispatch: schedule runs ahead + create many at once:**

A completeness audit found the Dispatch "Upcoming" tab was permanently empty and
runs couldn't be planned before their day — not a backend gap (`Job.scheduledAt`
and the Today/Upcoming/History filter already existed) but a UI one: nothing ever
set a schedule.

- **The New-job dialog now has a "Scheduled for" datetime field.** A future date
  lands the run under Upcoming; blank means today/unscheduled. That's the whole
  fix for the empty-tab bug — the plumbing was already there.
- **`POST /v1/jobs/bulk`** creates many runs in one request, each row an ordinary
  `CreateJobDto` created through the same validated `create()` path (timeline
  event, OPERATED relationship, operator notification, `scheduledAt` all apply
  identically), with the per-row independence every bulk path has — one bad row
  reports its own error and the rest still create. No new permission
  (dispatch:create).
- **FleetHQ "Add multiple" dialog** — deliberately the simplest thing that works:
  one run title per line, plus a single shared date and pickup depot applied to
  all. No spreadsheet, no column mapping. Per-line success/failure reported.
- Verified: 3 new e2e tests (including "a scheduled run lands in Upcoming, not
  Today"), all three apps lint/build/test clean.

**Wave J1 — DriverOS made fully usable offline:**

A completeness audit found nine places DriverOS broke its own "offline-first,
always" rule. All fixed so every core driver action works with zero connectivity
and reflects correctly:

- A stop completed offline updates the cached Today list optimistically (it
  stopped showing "Deliver →" for the rest of a dead-zone run); a pure,
  unit-tested `applyStopOutcome()` transform does it in both the live and offline
  caches.
- POD carries an `occurredAt` stamped at delivery time, so an offline delivery
  syncing hours later is recorded at the real time — the server clamps it (never
  future/implausibly old) so a bad device clock can't corrupt on-time reporting.
- Shift start/end reflects the intended state immediately when queued offline,
  instead of the widget showing the old state and inviting a duplicate tap the
  server would later reject (and dead-letter).
- Parcel manifest, notifications and the support phone number are cached, so the
  scan counter is right offline, the notifications screen says "offline" rather
  than "all caught up", and a stuck driver still gets the `tel:` number.
- Notification read-state is queued offline and applied to the cache, not lost.
- Dead-lettered mutations can be **reviewed and discarded** from the status bar,
  so a permanently-failed item can be cleared — before, the failed count could
  only ever grow.
- The Digital Glovebox shows the document number and opens the scanned file via a
  new asset/operator-scoped download route (gated on the same permission as the
  glovebox, so no blanket `attachments:view`). The scan needs a connection; the
  status/number/expiry a driver relies on roadside are already cached.
- `queueMutation` finds its ordering key with a key-cursor index instead of
  loading every queued photo body into memory on each capture.

> **Deliberately out of scope:** fatigue-hours accuracy for offline shift times.
> The founder is treating fatigue-compliance hours as not-yet FleetHQ's
> responsibility (to be built later), so shift event-time stamping was left alone
> even though the offline shift *widget-state* bug was fixed.

**Wave I8 — react-router advisory (GHSA-qwww-vcr4-c8h2), fixed forward:**

A new high-severity advisory landed on `react-router` covering **7.12.0 – 8.2.0**;
both frontends were on 7.18.1, so the hard-blocking `dependency-audit` gate went
red. Not introduced by us — published upstream between one push and the next.

- **Migrated both apps to `react-router@8.3.0`**, the patched line. `react-router-dom`
  has no 8.x: v8 consolidated it back into `react-router`, so the migration was
  the package name plus 44 import statements — every symbol FleetOS uses (`Link`,
  `NavLink`, `Navigate`, `Outlet`, `RouterProvider`, `createBrowserRouter`,
  `MemoryRouter`, `useNavigate`, `useParams`, `useSearchParams`) exists unchanged
  in v8. Both apps build, lint and test clean; audit reports **0 vulnerabilities**.
- **Chose forward over back deliberately.** `npm audit fix --force` would have
  *downgraded* to 7.11.0 — unaffected, but shedding seven minor releases and
  parking the apps on a line that stops receiving fixes. The advisory is
  RSC-mode-specific and FleetOS is a pure client-side SPA, so neither option was
  urgent on exploitability grounds; the tiebreaker was which version we'd rather
  be on in six months.
- **Added `router.spec.ts` — the test a router major upgrade should have had.**
  The route table is now exported separately from the router it's handed to, and
  four assertions hold it honest: every active sidebar entry resolves to a
  declared route, no duplicate paths, no route that renders nothing, and nothing
  but the auth pages reachable outside the protected layout. The first one catches
  a real class of bug nothing else could — a nav link added without its route,
  which type-checking can't see and only a customer finds. Verified by breaking it
  on purpose (`/fuel` → `/fuel-typo` fails the suite, restored passes).

> **Still outstanding, not blocking:** the API carries **moderate** advisories on
> `@nestjs/core` (injection, GHSA-36xv-jgw5-4q75) and `@opentelemetry/core` via
> `@sentry/node`. Both need major upgrades (NestJS 10→11, Sentry 8→10). The CI
> gate is `--audit-level=high`, so these don't block, and a framework major bump
> is its own reviewed piece of work — not a drive-by at the end of a feature wave.
> Named here so it's a scheduled decision rather than a forgotten one.

**Wave I7 — document import: bulk multi-file upload, into Documents, the Knowledge Base and Forms:**

Founder direction: "Should be able to import documents into the knowledge base as
well as documents and forms. There should also be a bulk option to upload as many
PDFs as they want so they can do it all at once."

- **`POST /v1/documents/bulk`** uploads a batch of files in one action, and
  **one bad file never takes the batch down with it** — a mislabelled PDF or an
  unsupported type reports its own error while every other file is created. It
  reports the same `ImportResult` shape as the CSV imports and runs each file
  through the ordinary `CreateDocumentDto` and `DocumentsService.create()`, so a
  bulk-uploaded document is identical to a hand-uploaded one. No new permission:
  it's gated on the existing `documents:create`.
  - **Titles are derived from filenames** (`Fatigue_Management_Policy_v3.pdf` →
    "Fatigue Management Policy v3"), which is what makes a 30-file import one
    click rather than 30 text fields. Unit-tested directly, because a wrong title
    on every file in a batch is exactly the small thing that makes a bulk feature
    feel broken.
  - **"As many as they want" is delivered by batching, not by a bigger limit.**
    Files travel as base64 inside a 15 MB body, so a large selection is split
    client-side into bounded requests and the per-file results are stitched back
    together with their original indexes. From the user's side: "I picked 60 PDFs
    and they uploaded."
  - **No `dryRun`, deliberately.** A dry run lets someone check a batch before
    paying the cost of committing it — but the cost of a file upload *is*
    transferring the bytes, and a dry run transfers them too. Same cost, almost
    no extra information, so it isn't offered. Reasoned in the DTO, not silently
    omitted.
- **Documents are referenced, never copied.** `KnowledgeArticle.sourceDocumentId`
  and `FormTemplate.referenceDocumentId` point at a `Document`, so a policy PDF is
  uploaded **once** and can be a document, a knowledge article and a form's
  reference material simultaneously — the zero-duplicate-data-entry rule applied
  to files. One upload path, one download path, one storage switch. The
  alternative (a `file_attachment_id` on each table) would have meant three
  upload paths and three chances to diverge.
- **Each surface serves the bytes from its own route**, gated on *that* surface's
  view permission: `GET /v1/knowledge-articles/:id/document` needs
  `knowledge:view`, `GET /v1/form-templates/:id/reference` needs `forms:view`.
  That's the point — publishing an SOP to drivers now actually makes it *readable*
  by them, without also handing them the whole document library. An article's
  document inherits the article's draft/published rule, and there's a test proving
  a plain reader gets 404 on a draft, 403 on the document library, and 200 once
  it's published.
- **An article can now be a document.** `body` is nullable and an article is
  authored markdown, an imported PDF, or both (a written introduction in front of
  the official document). The API refuses to create — or to *leave* — an article
  with neither, so unlinking the document from a body-less article is a clear 400
  rather than a silently empty page.
- **`publishToKnowledgeBase`** on a bulk upload creates a **draft** article per
  file: how a company gets a folder of SOPs into the knowledge base in one action.
  Drafts, because importing a folder is not a decision that every file in it is
  fit to publish company-wide. It requires `knowledge:create` *as well as*
  `documents:create`, checked in the service — that second permission changes what
  the request does rather than whether it's allowed, so it can't be a route-level
  `@RequirePermission`. Refused before anything uploads, never half-done.
- **One dialog, one picker, two pages.** `BulkDocumentUploadDialog` serves both
  the Documents library and the Knowledge Base (differing only by that flag), and
  `DocumentPicker` serves both the article editor and the form builder. Reuse
  before creation, so the loading, empty and failure states can't drift apart.
- **Two genuine de-duplications found on the way through**, both now single
  implementations: `membershipHasPermission()` (the permission-lookup query the
  guard and two services were each writing out) and `describeApiError()` — which
  existed as a **byte-identical private helper in 32 separate FleetHQ pages**.
- Verified: 7 new e2e tests + 11 new unit tests (API 80 suites / 360 tests;
  FleetHQ 8 files / 37 tests), all three apps lint and build clean.

> ⚠️ **Honest limitation:** a form's reference document is fetched on demand and
> is **not** pre-cached for offline use. Forms still submit fine with no signal —
> but the reference PDF won't open in a dead spot, and DriverOS says exactly that
> rather than failing silently. Nothing required to *complete* a form should live
> in that document. Caching arbitrary operator-facing files for offline use is a
> real piece of work (quota management, eviction, staleness) and deserves its own
> reviewed change rather than being implied by this one.

**Wave I6 — fuel card capture (DriverOS) + fuel tracking (FleetHQ):**

Founder direction: "there needs to be a fuel card feature as well where FleetHQ
tracks what the driver puts into DriverOS — odometer reading, picture of receipt,
last 4 digits of card used and licence plate."

- **New `fuel_entries` table + `/v1/fuel` module.** `POST /v1/fuel/entries`
  (permission `fuel:log`, what a driver has), `GET /v1/fuel/entries` and
  `GET /v1/fuel/summary` (`fuel:view`, what the office has) — so an operator who
  records fuel cannot read the whole company's spend. FORCEd RLS like every other
  tenant table.
- **Card data — the decision that matters.** Only the **last four digits** are
  ever accepted or stored. Enforced in *three* independent places so no single
  mistake can leak a PAN: `maxLength={4}` plus digit-stripping in the DriverOS
  input, `@Matches(/^[0-9]{4}$/)` on the DTO, and a database
  `CHECK ("card_last4" ~ '^[0-9]{4}$')`. Nothing logs it. A dedicated test submits
  a full 16-digit card number, a 3-digit slip, a non-numeric value and an empty
  string, and asserts all four are refused **and** that zero rows were written.
  Full card numbers, expiry dates and CVVs have no field to go in — by
  construction, not by policy.
- **The receipt photo reuses `AttachmentsService`**, so it inherits the existing
  type allow-list, magic-byte sniffing, size cap and S3/inline storage switch
  instead of adding a second upload path. Fuel rows carry attachment *metadata*
  only; the bytes are never inlined into a list response.
- **Offline-first, like POD.** Drivers fuel up at truck stops with no signal, so
  the entry queues in the existing outbox (receipt included, compressed before it
  ever reaches state) and replays later — stamped with `filledAt` set at fill
  time, not sync time, so fuel economy stays computable and the entry reconciles
  against the right statement line.
- **Fuel is asset history**, so a refuel writes a `fuel_recorded` event to the
  asset's timeline and shows up alongside its faults and services. The licence
  plate is normalised to upper case on write so `abc123` and `ABC123` reconcile
  to one vehicle.
- **FleetHQ `/fuel` page** (sidebar entry, gated on `fuel:view`): purchases /
  spend / litres tiles aggregated **in SQL** rather than by summing a fetched
  page, so the totals stay correct as the log outgrows one page, plus a log table
  with a `•••• 4321` card badge and receipt thumbnails.
- Verified: 4 new e2e tests (347 total in the API), permission catalogs in sync at
  92 permissions, all three apps lint/build clean.

**Wave I5 — live map TV / wall-display mode:**

Founder direction: "an interactive live map that can be displayed through another
computer at full screen so that companies can have a bigger TV showcase all their
trucks."

- **New `/live-map/tv` route**, rendered *outside* `AppShell` (no sidebar, no
  header) so the map is genuinely full-bleed, plus a real **Fullscreen API**
  toggle. Reached from a **TV mode** button on the live map that opens in a new
  tab, so the office can drag that window onto the TV and keep working in their
  own session.
- **Built for unattended operation, not just "the same page with chrome hidden":**
  - **Re-frames itself every 30s** as vehicles move, but any pan/zoom suspends
    that for 90s — so it stays *interactive* (someone can walk up and explore)
    without yanking the view out from under them, and resumes on its own.
  - **Bigger everything** — markers 14px vs the desk map's 9px, permanent unit
    labels, and a 5xl live counter, sized to read from across a room.
  - **Screen Wake Lock** (best-effort, re-acquired on tab re-focus) so the display
    doesn't sleep.
  - **Loud staleness banner.** The failure mode that actually misleads people is a
    wall display showing hours-old positions as if they were live, so the decision
    is a pure exported `isDataStale()` with a direct unit test, and a full-width
    warning appears once data stops refreshing.
  - Empty state *explains itself* rather than showing a blank screen.
- Both position sources (DriverOS phones + hardware GPS trackers) are merged and
  colour-separated, same as the desk map.
- Verified: 5 new tests (32 total in FleetHQ), lint and build clean.

> ⚠️ **Operational caveat for a permanent wall display:** the session token is a
> 12-hour JWT with no refresh token, so a TV left running will drop to the login
> screen roughly once a day and need someone to sign in again. Two honest options:
> raise `JWT_EXPIRES_IN` for the deployment (weakens security globally), or add
> refresh tokens — a change to the auth path that deserves its own reviewed piece
> of work rather than being rushed in alongside a UI feature. Flagged, not hidden.

**Wave I4 — attached units get a real detail view:**

Founder direction: "Attached units should also have a feature where you can click
it shows a lot more details as well." Clicking a unit did nothing, and there was
barely anything to show — `AttachedUnit` held only a name and an external
reference.

- **Gave the model the specs it was always missing** (`make`, `model`, `year`,
  `vin`, `registration`, `notes`, `customFields`) — deliberately the *same* fields
  and limits Asset already uses, because a trailer's identity data is the same
  kind of data as a prime mover's and two vocabularies would be worse than one.
  All nullable, so an existing company that only wants a name is unaffected. The
  validators live in one shared `AttachedUnitSpecsDto` that create and update both
  extend, rather than 40 duplicated lines.
- **`GET /v1/attached-units/:id/detail`** adds the genuinely new information: the
  **hitch history** — every asset the unit has been behind and when. It reads back
  the timed `PAIRED_WITH` fleet-graph relationships rather than a parallel log,
  because the graph already *is* that record (01-Product/Fleet_Graph.md); asset
  names resolve in one batched query so a long history stays a fixed number of
  round trips, and a since-archived asset still shows (that it *was* hitched
  remains true).
- **Spec edits are timelined.** A changed VIN or registration is exactly what an
  audit later needs to reconstruct, so the update path diffs the spec fields into
  the existing `updated` timeline event.
- **New `AttachedUnitDetailPage`** at `/attached-units/:attachedUnitId`,
  mirroring `AssetDetailPage`'s layout on purpose: identity/specs panel, hitch
  history table with the current pairing badged, and the entity timeline. Unit
  names in the list are now links; the form dialog gained the spec fields.
- Verified: 3 new e2e tests (specs round-trip, hitch history with an open pairing
  marked current, spec change on the timeline). API **343/343** across 77 suites;
  FleetHQ lint/tests/build clean.
- Two self-inflicted type errors caught by the build and fixed rather than papered
  over: `year` is held as a *string* in the form (matching `AssetFormDialog`, since
  coercion desynchronises zod's input/output types and breaks the resolver
  generic) and converted on submit; and `AttachedUnitDetail` no longer redundantly
  extends a specs interface now that `AttachedUnit` carries those fields itself.

**Wave I3 — built-in asset categories can now be removed (per company):**

Founder direction: "Allow them to remove built in categories." Previously only a
company's *own* categories could be removed; the built-ins (Land/Air/Sea) had no
Remove action at all.

- **Why it wasn't just "allow delete":** a built-in is a **single shared row**
  (`company_id IS NULL`) that every tenant reads. Deleting or archiving it to
  satisfy one company would have removed the category **for every customer** —
  a cross-tenant data bug. So removal is modelled as a **per-company
  suppression** instead.
- **New `HiddenAssetClass` table** (`hidden_asset_classes`): one row hides one
  built-in from one company. Unique on `(company_id, asset_class_id)` so removing
  twice is idempotent rather than a constraint error, FORCEd RLS `tenant_isolation`
  like every other tenant table, plus a reverse-lookup index on the FK.
- **Reversible by design.** `POST /v1/asset-classes/:id/restore` brings a removed
  category back — an irreversible hide would be a trap, since the company cannot
  recreate a built-in (its key would clash with the still-existing shared row).
- **Service:** `remove()` archives an own category but suppresses a built-in
  (returning `removed: 'archived' | 'hidden'` so the UI can be truthful);
  `findAll({ includeHidden })` filters removed ones out of pickers while the
  settings screen sees them flagged `isHidden` to offer Restore. Both paths keep
  the existing **in-use guard**, so removing a category can never orphan an asset.
- **FleetHQ:** Remove now appears for built-ins too; removed rows render greyed
  with a *Removed* badge and a Restore button. The confirm dialog and toast say
  explicitly that a built-in is hidden **for your company only** and other
  companies keep it — the effect is scoped, and implying otherwise would be
  misleading.
- **Caught and fixed a regression while doing it:** adding the optional
  `includeHidden` argument broke three call sites that passed
  `listAssetCategories` *directly* as a TanStack `queryFn` (which injects a query
  context as the first argument). Wrapped them as `() => listAssetCategories()`.
  Note for future work: FleetHQ's real typecheck is `npm run build` (`tsc -b`);
  bare `npx tsc --noEmit` resolves the root tsconfig, which is a references stub
  and checks nothing.
- Verified: 2 new e2e tests — one proving a built-in hidden for company A stays
  visible to company B and restores cleanly, one proving the in-use guard. API
  **340/340** (76 suites); FleetHQ lint/tests/build and DriverOS build all clean.

**Wave I2 — GPS trackers: the product now explains how to connect one:**

Founder feedback: "Please fix GPS trackers I cant figure it out and it should
tell me how its supposed to be done." The *backend* was fine (public key-authed
ingest, hashed keys, rate limiting, RLS). The **instructions** were the defect:

- **The absolute URL was never shown.** The UI printed the bare path
  `/v1/gps/ingest`, which a device cannot be configured with. Now derived from
  the browsing origin (the SPA proxies `/v1` on its own origin) and shown
  copyable — the single biggest blocker.
- **New `GpsSetupGuide` panel** (Fleet → GPS trackers, collapsible, always
  available — previously the only instructions lived in a one-time key dialog
  that was dismissed forever): 4 numbered steps, a **payload field table**
  (required vs optional, with the `lat`/`lng`-not-`latitude`/`longitude` trap
  called out), and a **runnable `curl`** to prove the pipeline before touching
  hardware.
- **Honest compatibility answer**, which is the real reason setup stalls: many
  cheap trackers only speak proprietary binary TCP/UDP and *cannot* POST JSON —
  they need a provider webhook or a small adapter. Says so plainly, and notes
  DriverOS phone reporting as the no-hardware alternative.
- **Troubleshooting table** mapping every real failure (`GPS_DEVICE_UNKNOWN`,
  `BAD_TIMESTAMP`, 400 validation, 429, "200 but never") to cause and fix.
- **The key dialog now includes a ready-to-run `curl` with the real key in it**,
  and the devices table **polls every 15s** so a tracker you just configured goes
  green by itself.
- **Fixed stale docs that actively misled:** `gps.service.ts` and
  `03-Hardware/GPS_Ingest.md` both still claimed the `gps_*` tables "aren't
  RLS-protected". They have been RLS-protected since the database-architecture
  review; ingest is the single documented `BYPASSRLS` exception. Corrected in
  both places, and the Playbook gained the operator-facing setup + compatibility
  + troubleshooting sections.
- Verified: 6 new component tests, FleetHQ **27/27** tests, lint 0 errors, build
  clean; API `tsc` clean and GPS suite 4/4.

**Wave I1 — Warehouse is now a real paywall (server-enforced add-on):**

Founder direction 2026-07-24: "warehouse should be behind a paywall please
ensure that it is." It was **not** — `warehouse` was a plan flag that only
drove UI presentation, with an explicit rule in `plans.ts` never to gate it at
the API. An SPA hiding a module is not a paywall: the endpoints were reachable
by any plan with a direct API call.

- **New `@RequireFeature` + `FeatureGuard`** (`common/decorators`,
  `common/guards`), mirroring the existing `@RequirePermission`/`PermissionGuard`
  pair rather than inventing a second mechanism. Resolves entitlements fresh per
  request (so a plan change needs no re-login) and rejects with **402
  `FEATURE_NOT_IN_PLAN`**. Registered as the APP_GUARD after `PermissionGuard`,
  so "you can't do this at all" (403) is answered before "your plan doesn't
  cover it" (402). Two orthogonal questions, two guards.
- **`WarehouseController` carries `@RequireFeature('warehouse')`** at class
  level — one line covers all 20+ routes, reads and writes.
- **Deliberately reverses** the documented "never gate warehouse at the API"
  rule, and `plans.ts` now says so explicitly rather than silently contradicting
  itself. Two properties of the original intent are preserved: **no data is
  destroyed or held hostage** (a lapsed plan makes warehouse data unreachable,
  never deleted; upgrading restores it intact), and **nothing bites before
  billing is live** (inert while `BILLING_ENFORCED !== 'true'`).
- **`warehouse-paywall.e2e-spec.ts`** proves all three: 402 on read *and* write
  for a Starter plan, success on Pro, and data surviving a downgrade →
  re-upgrade round trip.
- Verified: `tsc` clean, lint 0 errors, full API suite **338/338** (76 suites).

> ⚠️ **Operational note:** the paywall only takes effect once
> `billing_enforced = true` (Terraform) / `BILLING_ENFORCED=true`. Until then
> every company resolves to the unlimited tier and warehouse stays open.

**Wave H3 — Engineering Constitution: split the 915-line `jobs.service` god-file, graduate `max-lines` to `error`:**

The single file over 500 lines was the dispatch core. Split by concern, sharing
low-level helpers rather than duplicating them:

- **`JobsSupportService`** (new, `jobs.support.ts`) — job lookup, terminal-state
  guard, operator notification, and the timed `OPERATED` GraphRelationship
  open/close + the `JOB_INCLUDE` shape. Both services depend on it.
- **`JobStopsService`** (new, `job-stops.service.ts`) — the five stop operations
  (reattempt, add, manifest-import, reorder, complete-with-POD). completeStop's
  proof-storage, timeline, and job-roll-up were each extracted to named helpers.
- **`JobsService`** — now job-lifecycle only (409 lines, was 915), and its
  constructor drops from 7 to 5 injected deps (attachments/customers/
  notifications moved to the stops service), clearing its `max-params` warning.
  `assign`'s fatigue gate was extracted to `resolveFatigueGate`.
- Controller routes the five stop endpoints to `JobStopsService`; module
  registers both new providers. No endpoint, path, permission, or response shape
  changed — a pure internal decomposition.
- Promoted `max-lines` to **`error`**: no production file now exceeds 500 lines.
- Verified: `tsc` clean, lint 0 errors, full API suite **335/335** green.

**Wave H2 — Engineering Constitution: graduate `max-depth` to `error`:**

- Flattened the two production code paths that nested 4 blocks deep to ≤3:
  `graph-query.service.ts` (early-`continue` on relationship-endpoint
  classification) and `predictive-maintenance.service.ts` (extracted
  `groupFaultsByTitleSincePairing`, giving the "faults since pairing" step a
  name). Behaviour-preserving refactors; both services' e2e suites still pass.
- Promoted `max-depth` from `warn` to **`error`** in the API ESLint config — deep
  nesting can no longer regress into the codebase.
- Recorded that `max-params` deliberately stays `warn`: 4 of its violations are
  NestJS DI constructors (6–8 injected collaborators), which is idiomatic
  dependency injection, not a parameter-list smell. The genuine multi-argument
  methods remain tracked warnings.
- Verified: `tsc` clean, lint 0 errors / 77 warnings, full API suite 335/335 green.

**Wave H1 — Engineering Constitution: enforce code-size/complexity limits in tooling:**

Adopted the FleetHQ Engineering Constitution and made its quantitative limits
*enforceable* rather than prose. An audit first confirmed the codebase is already
largely compliant (4 of ~608 files over 500 lines; ~2 `any` in API, 0 in
frontends; no SQL/external calls in the presentation layer; lint + typecheck
already in CI for all three apps) — so this is a ratchet, not a rewrite.

- **Limits now live in the linters.** `max-lines` (500), `max-lines-per-function`
  (50), `complexity` (10), `max-depth` (3), `max-params` (5) added to ESLint
  (`apps/api`) and oxlint (`apps/fleethq`, `apps/driveros`), with test files
  exempt from the size/complexity rules. Every limit starts as `warn` so it is
  visible in the IDE and CI without breaking the build on pre-existing,
  defensible cases; each is promoted to `error` in the wave that drives its count
  to zero.
- **Deliberate severity split, documented in `docs/adr/0001-code-size-and-complexity-limits.md`:**
  `max-params`/`max-depth`/`max-lines` graduate to `error` (cheap + unambiguous);
  `max-lines-per-function`/`complexity` stay `warn` because the Constitution
  ranks readability over brevity — a linear 55-line function or a 200-line JSX
  component is one readable unit, not a defect, and mechanical splitting would
  harm it.
- CI stays green (warnings don't fail lint); the warning count is now a tracked,
  non-increasing number driven down opportunistically.

**Wave G1 — deployment-readiness: green the security CI gates:**

Triaged the four failing PR checks and made CI pass with *real fixes*, not suppression:

- **`dependency-audit` (real transitive vulns).** The production-dependency `npm audit` gate was failing on a **critical** (`tar`, pulled in via `bcrypt@5 → @mapbox/node-pre-gyp`) and a **high** (`lodash`, via `@nestjs/config`). Fixed at the source: upgraded **`bcrypt` 5 → 6** (drops the entire `node-pre-gyp`/`tar` chain — 29 packages removed), and pinned **`lodash` to `^4.18.1`** via `overrides` (the patched line, above the advisory's `<=4.17.23` range). `npm audit --omit=dev --audit-level=high` now exits clean; all 335 API tests still pass on `bcrypt@6` (existing `$2b$` hashes remain compatible).
- **`secret-scan` (gitleaks 403).** `gitleaks-action` was erroring `403 Resource not accessible by integration` *before scanning* (it calls the PR-commits API, which the default token can't on a private repo). Replaced it with the pinned **gitleaks binary run directly** as a full-history filesystem scan — no elevated permissions, and it actually scans now. Verified locally: **0 leaks across all 128 commits**.
- **`codeql` (GHAS-gated).** The SAST analysis *succeeds* (608 files, 0 real alerts); only CodeQL's code-scanning **status report** fails on a private repo without GHAS (`Resource not accessible by integration` → the action self-marks a "configuration error"). This is independent of the SARIF upload, so it can't be fixed by `upload: never` alone. Kept the action running (`upload: never`, SARIF published as a build artifact) but marked the analyze step **`continue-on-error`**, making CodeQL an **advisory, non-blocking** gate — it still scans every PR, it just doesn't red a merge over a GHAS licensing gap. Enable GHAS + set `upload: always` (drop `continue-on-error`) to promote it back to a blocking code-scanning gate. The three blocking security gates (secrets, deps, IaC) remain hard failures.
- **`dependency-review` (removed).** Hard-requires GHAS dependency graph and is redundant with the `npm audit` gate + Dependabot; removed the job. Re-add for PR-time dependency diffing once GHAS is on.

No application code changed — only `apps/api/package.json`, its lockfile, and `.github/workflows/security-scan.yml`.

**Wave F5 — edge WAF + TLS-only S3 bucket policies (last Phase-1 infra controls):**

- **AWS WAFv2 at the edge (R7 / ISO A.8.23).** Two web ACLs in `infra/terraform/environments/base/waf.tf`: a **REGIONAL** ACL associated to the ALB and a **CLOUDFRONT** ACL (us-east-1, via the existing provider alias) attached to both SPA/PWA distributions. Each carries the AWS managed **Common** + **Known-Bad-Inputs** rule groups and a **per-IP rate-based rule** (2,000 req / 5 min) that blocks before traffic reaches the ECS tasks — L7 protection layered ahead of the app-level throttler.
- **TLS-only S3 bucket policies (ISO A.8.24 / SOC 2 CC6.7).** Explicit `aws:SecureTransport=false` **deny** policies on the attachments bucket (`modules/api-service`) and the SPA site buckets (`modules/frontend`), so any non-HTTPS request to S3 is refused.
- **Fixed an IAM gap the erasure control depended on:** the ECS task policy granted only `GetObject`/`PutObject`, so the Privacy-Act versioned-erasure would have failed with AccessDenied in production. Added `DeleteObject`, `DeleteObjectVersion`, `ListBucket`, and `ListBucketVersions`.
- Verified: `terraform fmt -check` + `terraform validate` clean across the whole config. Synced the affected docs (readiness Phase-1 item 4 done, risk-register R7 → Low, network + data-handling gap notes).

**Wave F4 — Phase 2 & 3 execution artifacts (governance records + external-audit engagement):**

The parts of certification a repository *cannot do* (sign a policy, assign a human owner, be a pen-tester/CPA firm, run a 3–12 month observation) are reduced to fill-in-the-blank records and runbooks so a human/auditor can execute them immediately:

- **`governance-execution.md` (Phase 2):** ownership register (role→named-owner), policy sign-off log, quarterly management-review log, sub-processor & DPA register, and an onboarding/annual/offboarding HR security checklist — each marked as a *record to be completed by a named person*.
- **`audit-engagement.md` (Phase 3):** an **evidence register** mapping every control to where its evidence lives (for the auditor), an independent **penetration-test scope/RFP** (cross-tenant access first), and step-by-step **SOC 2** (incl. the Type II observation-period) and **ISO 27001 Stage 1/2** engagement runbooks.
- Updated `readiness.md` to mark the Phase-1 technical controls done (retention, erasure completeness, security alerting, CODEOWNERS) and the README index to include both new docs. Every doc is explicit that these are records/plans to be executed, not "certified."

**Wave F3 — Phase-1 remaining technical controls (retention, erasure completeness, security alerting, code ownership):**

Closes the open technical items from the readiness roadmap (risk-register R3/R4/R5/R14):

- **GPS breadcrumb retention purge (R4).** New `RetentionService` + a leader-elected scheduler task purges `gps_pings` older than a configurable floor (default 18 months) per-tenant via `withTenant` (no new grants — the runtime role already holds DELETE on that table). Location history is personal data, so it is no longer kept indefinitely. e2e proves old breadcrumbs are purged, recent ones kept, and the purge is tenant-scoped. *(ISO A.8.10)*
- **Erasure completeness (R5).** `AttachmentStorage.remove()` now enumerates and deletes **every S3 object version + delete-marker** for a key, not just the current version — so a Privacy-Act erasure of a licence/medical scan can't leave a recoverable prior version on a versioned bucket.
- **Security-event alerting (R3).** New CloudWatch Logs **metric filters + alarms** on the API's structured logs — a failed-login spike (brute-force / credential-stuffing) and an account-lockout burst — wired to the existing alerts SNS topic; the auth service now emits `auth.account_locked` to the structured log for the filter to match. *(SOC 2 CC7.2 / ISO A.8.16)*
- **Code ownership (R14).** `.github/CODEOWNERS` marks the security-critical paths (auth, audit, permissions, prisma, migrations, infra, security/compliance docs) for required review once branch protection is enabled. *(ISO A.8.4 / SOC 2 CC8.1)*
- Verified: API **75 suites / 335 tests** green (+ retention e2e); `tsc` clean; `terraform validate` + `fmt` clean.

**Wave F2 — ISMS / governance documentation (the ISO 27001 / SOC 2 governance layer):**

The technical controls were the strong half; the governance layer auditors also require is now written, under `docs/compliance/`:

- **Statement of Applicability** — every one of the 93 ISO/IEC 27001:2022 Annex A controls with applicability, status (Implemented / Partial / Planned / Inherited-AWS / N/A), and source-level evidence. Technological (A.8) controls are overwhelmingly implemented; the Planned items concentrate in organizational/people controls (owners, HR, signed policies).
- **SOC 2 control matrix** — the Trust Services Criteria (CC1–CC9 + Availability + Confidentiality) mapped to controls + evidence. CC6 (logical access) and CC8 (change management) are FleetOS's strongest; the open items are monitoring/alerting (CC7.2), restore testing (A1.3), and governance (CC1–CC3).
- **Risk register** — 15 identified risks scored likelihood×impact to a residual rating after existing controls, with treatment + owner; no High residual remains.
- **Security policy set** — InfoSec, access control, cryptography, data classification/retention, secure development, acceptable use/endpoint, HR, vendor management, BCP, and governance/management-review policies.
- **Readiness re-score** — honestly separates *controllable readiness* (~95%, essentially done) from *certification*, which is external and time-bound: SOC 2 Type II needs a 3–12 month observation period by an independent CPA firm, and ISO 27001 needs an accredited certification body (Stage 1 + Stage 2). Post-MFA scores: Cyber Essentials ~93%, ISO audit-readiness ~88%, SOC 2 design-readiness ~87% (up from 80/55/58). A `README` states plainly that FleetOS must not be represented as "certified/compliant" until an external report exists.

**Wave F1 — Multi-factor authentication (TOTP) — the #1 ISO 27001 / SOC 2 / Cyber Essentials control gap, now closed:**

Every prior readiness assessment named "no MFA" as the single binding technical gap. It is now implemented end to end:

- **Dependency-free RFC 6238 TOTP** (`apps/api/src/auth/mfa/totp.ts`) — SHA-1, 6-digit, 30s, with base32 + HOTP, proven against the **published RFC 4226 / 6238 test vectors** (`totp.spec.ts`). No third-party crypto dependency in the auth path.
- **Two-step enrolment** (`MfaService`): setup issues a secret (stored *pending*), confirm verifies a code and activates MFA (`mfa_enabled_at`) — a half-finished enrolment can never lock anyone out — then returns **10 single-use backup codes** (bcrypt-hashed; a used one is consumed).
- **Enforced at login.** `AuthService.login` now returns `mfa_required` + a short-lived challenge token when MFA is active; `POST /v1/auth/mfa/verify` exchanges a TOTP *or* a backup code for the session. Post-factor flow (single vs. multi-company) is unchanged. New audit events `auth.mfa_enabled` / `auth.mfa_disabled` / `auth.mfa_challenge_failed`.
- **Schema:** `users.mfa_secret` / `mfa_enabled_at` / `mfa_backup_codes` (migration `20260724140000_user_mfa`; column-scoped UPDATE grant to the pre-tenant `fleetos_auth` role).
- **FleetHQ UI:** the login page prompts for the code on `mfa_required`; the profile page has a self-service enrolment card (add the key to an authenticator app → confirm → save backup codes) and a code-gated disable.
- Verified: API **74 suites / 333 tests** (+ TOTP unit vectors + full MFA e2e: enrol → challenge → wrong-code rejected → TOTP verify → single-use backup code → disable); FleetHQ `tsc` + `oxlint` + vitest(21) + build all clean.

**DB Wave 2 — database architecture documentation suite + final assessment:**

`docs/database/` — the enterprise database documentation the review asked for, grounded in the schema, migrations, and live catalog: a **README/overview**, an **audit** (Critical→Low findings, core design principles, normalisation with documented deviations), an **entity-relationship model** (Mermaid ERD + relationship catalogue with cardinality & rationale), a **security model** (RLS mechanics, the three-role least-privilege split, encryption, injection/leakage defence), an **index & performance strategy**, a **migrations/backup/scaling strategy** (10→10,000-company path), and a **final assessment** (architecture verdict ~86/100, changes, residual risks, scalability, ISO 27001 DB alignment ~66/100, SOC 2 DB alignment ~65/100, and a phased roadmap).

**DB Wave 1 — database hardening from a full architecture audit (GPS RLS + reverse-lookup indexes):**

A complete database review (schema, migrations, live catalog: RLS status, indexes, foreign keys) confirmed a strong foundation — database-enforced RLS tenant isolation on 40+ tables, UUID keys, versioned migrations, composite hot-path indexes. It surfaced two concrete, safe improvements, both implemented and verified:

- **Closed the one tenant-isolation gap.** `gps_devices` and `gps_pings` carried `company_id` but were the *only* tenant tables without row-level security — isolation rested on the service-layer `companyId` filter alone. RLS is now enabled + forced on both (migration `20260724130000_gps_rls`), with a `tenant_isolation` policy. The device-key **ingest** path (which has no user/company context) is routed through the `BYPASSRLS` role in `gps.service.ts`, so it keeps its necessary global device lookup while every user-facing read is now database-enforced. The e2e proves isolation *at the database* — as the RLS-subject app role, tenant B's GUC cannot see tenant A's device or pings even with a direct query.
- **Added the missing reverse-lookup FK indexes.** Most tenant-scoped FK lookups were already covered by the Wave-A `company_id`-leading composites; the genuinely-unindexed *reverse* lookups (memberships→role, assets→class, operators→fatigue-rule-set, part-usage→part, submissions→template, role→permission) are now indexed (migration `20260724131500_fk_reverse_lookup_indexes` + `@@index` in the schema). Kept deliberately narrow to avoid over-indexing.
- Verified: API `tsc` clean; `prisma validate` clean (index names match Prisma's convention, no drift); **72 suites / 307 tests** green.

**Wave E3c — Cyber Essentials security documentation suite + readiness assessment:**

The capstone of PART 13: an evidence-based security control set that an enterprise buyer or auditor can read, plus the honest readiness scoring the mandate asked for.

- **`docs/security/cyber-essentials/`** — 11 control-domain documents (secure network architecture, secure configuration, access control, patch/vulnerability management, malware & file uploads, secure SDLC, authentication, device/session, monitoring & audit logging, secure data handling, security testing), each with **Intent → What's implemented (with `path:line` evidence) → Gaps & residual risk (severity + plan) → Standards mapping (Cyber Essentials / ISO 27001:2022 Annex A / SOC 2)**. Plus an operational **incident-response plan** (severity tiers, phases, Australian NDB obligations) and a **backup & disaster-recovery plan** (RDS PITR + cross-region snapshot copy + S3 versioning, with honest "not yet drilled" caveats), and a `README.md` index.
- **`SECURITY.md`** at the repo root — a vulnerability-disclosure policy with a private reporting channel and response SLAs (closes the "no disclosure channel" audit gap).
- **`readiness-assessment.md`** — the requested scoring: **Cyber Essentials ≈ 80/100** (binding gap: MFA for admin accounts), **ISO 27001 alignment ≈ 55/100** (strong Annex A technical controls, ISMS governance largely absent), **SOC 2 alignment ≈ 58/100** (strong CC6, improving CC7, no observation period yet), a per-domain scorecard, a prioritised weakness register, and a phased remediation roadmap (Phase 1 certification-blockers: MFA, security-event alerting, edge WAF, branch protection).
- Grounded in a parallel 12-domain evidence audit; scores reflect the post-E1/E2/E3 state (the audit's SCA/SAST/secret-scanning, default-account, and unwired-privilege-logging findings are shown as remediated, since those waves closed them).

**Wave E3b — infrastructure hardening (encrypt-in-transit to the DB + IaC security gate):**

- **Database connections forced onto TLS.** `rds.force_ssl=1` is now set on the RDS parameter group (`modules/database`), and the app/auth connection strings request `sslmode=require` (`environments/base`). Traffic already stayed inside private subnets, but now a misconfigured or compromised in-VPC host cannot open a cleartext session to the database — encryption in transit to RDS is enforced end to end, closing a HIGH audit finding.
- **Terraform CI gate.** New `terraform-ci` workflow runs `terraform fmt -check`, `terraform validate`, and a **tfsec** static IaC security scan on any change under `infra/terraform/**`. A regression that opened the DB security group, set `publicly_accessible=true`, dropped the HTTP→HTTPS redirect, or removed `force_ssl` now fails the PR instead of reaching `apply`.
- Verified locally: `terraform fmt -check -recursive` clean; `terraform init -backend=false` + `terraform validate` → "The configuration is valid."

**Wave E3a — audit findings remediation (default-account fix + privilege audit trail):**

A parallel evidence-based audit against 12 Cyber Essentials-style control domains surfaced a set of implementable gaps; the high-value, low-risk ones are fixed here before the readiness write-up:

- **Production default-account vulnerability (critical) — fixed.** Every production deploy runs `npm run seed`, and the seed script *unconditionally provisioned two demo companies* (`admin@acme`, `admin@southernstar`) with a hardcoded default password — real, loginable tenant accounts, credentials even printed to the deploy log. `prisma/seed.ts` now gates all demo-company/demo-data creation behind `NODE_ENV !== 'production'`; in production the seed is reference-data + system-role reconciliation only. `deploy-api.yml` sets `NODE_ENV=production` on the seed step so the gate reliably engages.
- **Privilege & admin-action audit events — now actually written.** The E1 audit catalog *declared* `access.role_permissions_changed`, `access.user_created`, `access.user_role_changed`, `access.user_access_revoked`, and `gps.device_key_rotated`, but nothing emitted them. They're now recorded (atomically, in the same transaction as the change) from `RolesService.update` (permission-set changes only), `UsersService` (create / link / role-change / deactivate), and `GpsService.rotateKey`. Privilege changes and account lifecycle are the events an auditor most needs — this is the "logging for any required audits" made real. New e2e proves an admin creating a user is recorded and readable.
- **DB-credential fail-fast.** `env.validation.ts` now refuses to boot in production if any database URL still carries a dev-only role password (`fleetos_*_dev_only`) — a guessable production DB credential crashes the process at startup instead of serving traffic. Unit-tested.
- **JWT algorithm pinned.** `JwtStrategy` now sets `algorithms: ['HS256']`, foreclosing algorithm-substitution attacks (`alg:none`, RS256-key-as-HMAC) rather than trusting the token header.
- Verified: API `tsc` + lint clean; **72 suites / 307 tests** green (+3).

**Wave E2 — security scanning in CI + config hardening (Cyber Essentials: patch mgmt & secure SDLC):**

Moved the "we should check for vulnerable dependencies / leaked secrets" intent from aspiration to an enforced gate on every push and PR:

- **`security-scan` workflow** with four independent gates: `npm audit` per app (fails on high/critical in *production* deps — dev-tooling vulns don't block since they never ship), **CodeQL** static analysis over all repo JS/TS with the stricter `security-and-quality` query suite, **dependency-review** on PRs (blocks a PR that would *introduce* a vulnerable package), and **gitleaks** secret scanning over full history. Also runs on a weekly cron so a newly-published advisory against unchanged code still gets caught.
- **Dependabot** across all three deployables (api / fleethq / driveros) plus the GitHub Actions themselves, grouping routine minor/patch bumps into one weekly PR per app while security updates still open immediately.
- **`.gitleaks.toml`** starts from the full default ruleset and allowlists only the handful of intentional dev-only placeholders (docker-compose/CI/`.env.example` values that grant access to nothing real — production secrets come from AWS Secrets Manager, and `env.validation.ts` rejects the placeholders in prod), so the scan stays focused on real leaks.
- **HSTS hardened.** `main.ts` now sets an explicit 2-year `max-age` with `includeSubDomains` + `preload` instead of relying on helmet's 180-day default — the HSTS-preload-list bar.
- Verified: API `tsc` + `build` clean; all three scan configs parse (YAML + TOML validated).

**Wave E1 — security audit log (Cyber Essentials: monitoring & accountability):**

Enterprise buyers (and ISO 27001 A.8.15 / SOC 2 CC7) require a tamper-evident record of *who did what*. Added a first-class, append-only audit trail rather than scattering `console.log`s:

- **Append-only `audit_logs` table.** New migration creates the table with an RLS `tenant_isolation` policy (FORCE ROW LEVEL SECURITY) and grants the app role only `SELECT, INSERT` — never `UPDATE`/`DELETE`, so the trail cannot be rewritten or quietly pruned from application code. Rows capture actor, action, target, outcome, IP, request-id and a JSONB metadata bag. Indexed for the company-scoped, most-recent-first read.
- **`AuditService` with three write modes.** `recordInTx` writes the audit row *inside the same transaction* as the action it describes (a data export can't be recorded-but-not-happen, or vice-versa); `record` is best-effort post-hoc; `recordSystem` writes pre-tenant events (a failed login, where the company isn't yet known) via the BYPASSRLS auth role. A `@Global()` module exposes it everywhere.
- **Events wired.** Authentication: `login_succeeded`, `login_failed`, `account_locked` (with client IP + request-id), `password_reset`. Privacy Act: `data_exported`, `data_erased` (recorded atomically with the export/erasure). Failed logins are recorded **system-level** (`company_id = null`) on purpose — a bad attempt on a username that may belong to several companies isn't attributable to one tenant, so it's kept out of any tenant's view and read only via the auth role.
- **Read path.** `GET /v1/audit-logs` (new `audit:view` permission, added to both permission catalogs) returns the company's own trail, paginated, filterable by action/outcome, RLS-scoped so one tenant can never see another's events.
- Verified: API **72 suites / 304 tests** green (+4 audit e2e: deterministic export record, system-level failed login via the auth role, `audit:view` gate → 403, tenant isolation), `tsc` clean.

**Wave D — FleetHQ premium data-grid (pagination + real server-side search):**

The registry list pages fetched a fixed 100–200 rows and filtered them *in the browser*, which silently truncated the list and — worse — made the search box a correctness bug: searching a tenant with more records than the fetched page returned false negatives for anything past it. Fixed end to end:

- **Server-side search.** Added a `search` field to the shared `ListQueryDto` (and removed the four now-redundant per-DTO copies) and wired case-insensitive multi-column search into the Operators (name/email/phone), Assets (name/make/model/rego/VIN/reference), Customers (name/contact/phone/address), and Depots (name/address/notes) services. The filter now runs across the *whole* set in SQL. e2e proves a needle on a later page is still found (and matched on a secondary field).
- **Shared `usePaginatedList` hook.** One place owns list pagination + debounced search: it snaps to page 1 when the term changes and keeps the previous page visible while the next loads (`keepPreviousData`, no flash). Every registry page uses it instead of hand-rolling a capped fetch + in-memory `.filter()`.
- **Honest pagination footer.** A shared `Pagination` component shows "Showing X–Y of N" (so a truncated list can never masquerade as the whole set) plus prev/next paging; hidden when everything fits on one page.
- **Sticky table headers.** Column headers stay pinned while the body scrolls.
- **Fixed two pre-existing FleetHQ type errors surfaced by the build** (a missing `assetClassId` on `CreateAssetInput`, and a stale auth-context mock missing `signup`) — the frontend `tsc -b` is green again.
- Verified: FleetHQ `tsc` + `oxlint` + vitest(21) + build clean; API **71 suites / 300 tests** green.
- Deferred (larger, needs a backend `orderBy` param and a virtualization lib): column sorting, table virtualization, bulk multi-select, saved views — the next tier of data-grid polish.

**Wave C — security depth:**

- **GPS device keys are hashed at rest.** A tracker's bearer key is now stored only as a SHA-256 hash (`device_key_hash`), never plaintext — ingest resolves the tenant by hashing the presented key and looking it up (a fast deterministic hash is right here: the key is 32 bytes of entropy, so there's nothing to brute-force, and it stays a single indexed query). The plaintext is shown exactly once, at registration/rotation. Additive migration backfills existing rows via pgcrypto, then drops the plaintext column.
- **Per-device GPS ingest throttle.** A dependency-free per-device fixed-window limiter (120 positions/min) on top of the global per-IP throttle, so a leaked device key can't flood the ping table. In-memory / per-instance (best-effort, documented), with a bounded, self-pruning tracker map.
- **Attachment magic-byte sniffing.** Every upload's real bytes are now checked against its declared content type (JPEG/PNG/WebP/PDF signatures); a mislabelled or disguised file is rejected with `ATTACHMENT_CONTENT_MISMATCH` instead of being stored as something it isn't. e2e proves a text file labelled `image/png` is refused.
- **Password strength policy.** A shared `@IsStrongPassword()` validator (≥8 chars, ≥2 character classes, not a well-known common password) now guards every place a password is set — signup, invite/create-user, reset, operator-link — replacing the bare min-length check. Unit-tested.
- **JWT session revocation.** Every session token now carries the user's `tokenVersion`, and the JWT strategy rejects a token whose version has moved on. A password reset bumps the version, so a reset immediately invalidates every existing session for the account (not just for the token's remaining 12h) — the enterprise expectation for "reset kills other sessions". Costs one indexed PK lookup per authenticated request. e2e proves a pre-reset token is `TOKEN_REVOKED` afterward while a fresh login works.
- Verified: API **71 suites / 299 tests** green, `tsc` clean.

**Wave B — DriverOS offline hardening (courier-first: no lost proof of delivery):**

The offline re-audit found the outbox replay was built for the happy path — its failure modes could each cost a driver a day's proof-of-delivery in exactly the remote-highway / mine conditions the product targets. Fixed the data-loss blockers:

- **Poison-replay is dead — one bad item can no longer freeze the whole queue.** The replay loop now classifies each failure: transient (offline / 5xx / 408 / 429) stops the pass in place, keeping strict FIFO and retrying on the next `online` event, queued mutation, or a new 30s periodic sweep; a *permanent* client error (a non-retryable 4xx — a stop already completed, a shift already ended) is moved to a new `deadLetter` IndexedDB store and the drain **continues past it**. So a single poisoned POD can never block a driver's later "broke down, need help" message from ever sending. The StatusBar surfaces dead-lettered items with a **Retry** self-rescue action; the pending badge now counts via `db.count` instead of deserialising every queued photo body. Covered by new unit tests (dead-letter + continue, FIFO on transient, retry-drain).
- **POD photos are downscaled on capture.** A phone's 4–12 MP camera JPEG is re-encoded to ≤1600px / q0.7 *before* it reaches state or the outbox — legible proof, but small enough to never trip the server's 8 MB cap (which offline would only surface as a replay poison) and to stop base64 photos bloating IndexedDB on a long dead-zone run. Falls back to the original bytes on any failure (never gates recording a delivery), with a client-side size guard as a backstop.
- **Storage-full never silently loses a delivery.** `queueMutation` now maps a `QuotaExceededError` to a typed `OutboxQuotaError`, and the capture screen shows a distinct, actionable message and keeps the driver on the page — the POD is never reported saved when it wasn't.
- **Request timeout.** The DriverOS API client now has a 30s timeout, so a POST hung on a marginal link becomes a normal retryable failure instead of stalling the entire outbox drain indefinitely.
- Deferred (noted for a follow-up): per-mutation client idempotency keys for messages / fault reports / shifts (duplicate-on-replay is a quality nit, not data loss, now that poison items no longer block the queue).
- Verified: DriverOS `tsc` + `oxlint` clean, **vitest 23 tests** (was 17), production build green.

**Wave A — backend correctness / security / scale:**

- **Fail-fast environment validation.** `ConfigModule` now runs a dependency-free `validateEnv` at boot: a missing database URL or `JWT_SECRET` crashes the process before it serves a request (every environment), and in production a `JWT_SECRET` that is the in-repo placeholder or under 32 chars is rejected too — so a real deploy can never silently ship a forgeable-token secret. Dev/CI keep the frictionless weak secret. Unit-tested.
- **Data-model indexes + integrity (additive migration).** Foreign-key composite indexes leading with `company_id` on `maintenance_jobs`, `compliance_documents`, and `jobs` (per-asset / per-operator lookups were scanning); a partial **unique** index enforcing one ACTIVE shift per operator (closes the check-then-insert race in `ShiftsService`); partial unique indexes making an asset's VIN and registration unique per company among live rows (with a friendly `409 ASSET_VIN_TAKEN` / `ASSET_REGISTRATION_TAKEN` pre-check, reusable after archiving); and a partial index covering the notification-digest sweep. e2e proves the VIN rules (per-company scope + archive-frees-reuse).
- **Compliance-expiry alert sweep.** A new leader-elected scheduler job raises an in-app notification the first time a compliance document crosses into "expiring soon" (≤30 days) or "expired". Idempotent via per-document `expiring_alerted_at` / `expired_alerted_at` marks (each alert fires once over the document's life, not every tick), fans out to `compliance:view` holders, is per-tenant, and is backed by a partial expiry index. New notification types `compliance_expiring` / `compliance_expired`. e2e proves correct + once-only + tenant-scoped.
- **Reporting aggregation pushed into SQL.** `ReportsService.operations` and `.impact` no longer `findMany` every stop / submission / maintenance job into Node and reduce in JS — they run grouped SQL (`count(*) FILTER (...)`, `date_trunc` day/month buckets, per-operator joins) inside `withTenant` (RLS-scoped), and only load the small set of assets that actually had downtime. Same output, but a multi-million-row window no longer risks memory/latency. All eight reporting e2e assertions unchanged and green.
- Verified: API **70 suites / 292 tests** green, `tsc` clean.

- **Scheduler leader election.** The opt-in background scheduler now gates each tick on a database lease (`scheduler_leases` table, atomic claim-or-take-over-on-expiry), so `SCHEDULER_ENABLED=true` is safe on *every* replica in a multi-instance deployment — the job fires once per interval, not once per replica. Pool-safe (no session locks), no external coordinator. e2e proves single-winner + expiry reclaim.

## 2026-07-23 — Scale + quality pass (production-readiness ~86 → ~89)

Closed the real remaining engineering gaps behind the score, kept everything green, no rewrites.

- **N+1 write loops removed.** `maintenance-schedules.deployTemplate`, `warehouse.copyMachineSchedule` (both were a `findFirst` per asset×item) and `jobs.duplicate` (a `create` per stop) are now **set-based**: one read of existing rows, in-memory revive/create decisions, batched `updateMany`/`createMany`. Deploy cost drops from O(assets×items) round-trips to O(items).
- **Vendor bundle-splitting.** FleetHQ `vite.config.ts` splits the long-lived core (React/router, TanStack Query, Radix) into their own cacheable chunks so a routine app deploy no longer re-downloads them; route-only libs (Leaflet) stay inside their `React.lazy` chunk. Lazy page consts moved to `app/lazyPages.ts` (keeps `router.tsx` clean and lint-quiet).
- **Index-verified scale test.** New `test/scale-performance.e2e-spec.ts` seeds one tenant with **12,000 delivery stops**, then proves the impact report (a) stays correct, (b) uses `job_stops_company_id_completed_at_idx` via `EXPLAIN` (no Seq Scan), and (c) returns in <2s. The honest, repeatable stand-in for a production load test.
- **More frontend tests.** Australian-vehicle quick-fill data logic + the TrialBanner conversion component (active/singular/hidden states). FleetHQ vitest now 21 tests.
- **Deliberately NOT split `jobs.service`.** Its stop methods operate on the Job aggregate root; keeping aggregate operations cohesive is a considered DDD stance, not debt — and fracturing the most critical, most-tested service for a modest file-size win is churn without benefit.
- **Re-scored honestly** (`02-Architecture/Codebase_Audit_2026-07.md`): Performance 83→90, Scalability 83→88, Testing 84→88, Maintainability 88→89, Architecture 88→89 → **overall ~89/100**, with an explicit "honest ceiling" note: past ~90 needs real production signal (concurrent load, enterprise SSO/audit, operational maturity, customer battle-testing), not more code.
- Verified: API 67 suites / 277 tests, tsc + eslint clean; FleetHQ tsc/oxlint/vitest(21)/build clean.

## 2026-07-23 — Hardening pass: worked the audit's "next 10" engineering priorities

Executed all ten follow-up items from `02-Architecture/Codebase_Audit_2026-07.md`, keeping everything green. Scope was deliberately surgical (no rewrites, no new frameworks).

1. **Pagination hardening.** The per-operator message thread was the one genuinely unbounded list read on a hot table — now capped to the 200 most recent (chronological order preserved). All other user-facing list endpoints were already bounded via `ListQueryDto` (default 25 / max 200). A blanket "forbid unbounded `findMany`" lint was evaluated and rejected: it produces false positives on legitimate domain-complete reads (all stops for a job) and batch reads (the digest), so per-call judgement + a documented policy is the right tool.
2. **Route-level code-splitting (FleetHQ).** Feature pages are now `React.lazy` chunks behind a Suspense boundary in the app shell. The build went from one ~1.28 MB JS bundle to **77 chunks**, with the initial bundle down to ~642 kB (gzip 366→201 kB, ~45% smaller first load). Auth/shell stay eager on the critical path.
3. **Permission-catalog parity check.** `scripts/check-permission-parity.mjs` (dependency-free) fails if the API and FleetHQ catalogs drift; wired into a dedicated `permission-parity` CI workflow. Currently 89 permissions, in sync. `npm run check:permissions`.
4. **Scheduled-jobs runner.** New opt-in `SchedulerModule` (`SCHEDULER_ENABLED=true`, off in dev/test) — a dependency-free guarded `setInterval` (no `@nestjs/schedule`, which conflicts with the pinned Nest versions) that runs each company's notification digest on a daily cadence. Cross-tenant enumeration uses the existing privileged read-only role, extended narrowly with `SELECT` on `companies`.
5. **Observability: request/trace IDs.** pino now honours an upstream `x-request-id` (else mints one) and echoes it on the response; it's stamped on every log line, forwarded to Sentry as a tag on 5xx, and included in the error envelope as `requestId` — one id ties a client report, the log, and the Sentry event together.
6. **Composite indexes.** Six new composite indexes matching real query patterns (`job_stops(company_id, completed_at)`, `timeline_events(company_id, occurred_at)`, `notifications(company_id, recipient_user_id, created_at)`, `messages(company_id, operator_id, created_at)`, `checklist_submissions(company_id, submitted_at)`, `jobs(company_id, scheduled_at)`). Additive migration.
7. **GPS tenant-isolation compensating control.** Added an e2e proving one tenant's GPS positions never leak into another's map — the regression guard for the service-layer `companyId` filter on the intentionally non-RLS gps tables.
8. **Frontend integration tests.** Added a SignupPage integration test (validation, password mismatch, success→navigate, API-error surfacing). The DriverOS offline sync engine already had coverage.
9. **Engineering README.** Confirmed + extended with the repo scripts and API-docs pointers (added last pass).
10. **API surface published + versioning policy.** `scripts/generate-api-reference.mjs` emits `12-API/API_Reference.md` (240 routes across 47 controllers, with required permission per route) — dependency-free, since `@nestjs/swagger` conflicts with the pinned Nest versions. New `12-API/API_Versioning_Policy.md` defines breaking-vs-additive, the deprecation window (Deprecation/Sunset headers, ≥90 days), and stability tiers. `npm run docs:api`.

Verified: full API suite green (+2 e2e), API tsc/eslint clean, FleetHQ tsc/vitest/build clean.

## 2026-07-23 — Codebase audit + targeted reduction (staff-engineer pass)

A full ten-phase audit of the whole monorepo (architecture, dead-code/duplication, DB, security, performance, testing, scaling). Headline finding: the codebase is already professional-grade — strict typing (4 `any` in ~42k LOC), zero stray `console.log`, every tenant model indexed on `companyId` (49 index declarations), only 2 raw SQL calls (both parameterized), no hardcoded secrets, 275 passing API tests. So this pass *validated and hardened* rather than rewrote — aggressively refactoring clean code would only add risk.

- **Full report:** `02-Architecture/Codebase_Audit_2026-07.md` — architecture map, good/bad decisions, risks, a proposed-changes table with impact + risk, a production-readiness score (**~84/100**), and the next 10 engineering priorities.
- **Executed reductions (safe, verified):** deleted 2 genuinely-unused UI primitives (`tooltip.tsx`, `breadcrumbs.tsx`, 52 LOC) and removed the 3 dependencies they freed (`@radix-ui/react-tooltip`, `@radix-ui/react-popover`, `date-fns`) from FleetHQ. Both frontends still typecheck + build clean.
- **Deliberately NOT done (documented):** a shared frontend package (would couple two independently-deployed apps to save ~150 lines — net-negative) and a permission-catalog de-dup abstraction (a cheap CI parity check is the right guard, not a new layer).
- **Top tracked debt** (in the report's next-priorities): default pagination caps on high-volume list endpoints (the one real scaling risk — 118 unbounded `findMany`), route-level code-splitting in FleetHQ (~1.3 MB first-load chunk), a permission-catalog parity CI check, and a scheduled-jobs runner.
- **Docs:** added a repo-root engineering `README.md` (stack, layout, architecture-at-a-glance, coding standards, testing, deployment) so a new engineer can orient without reading the whole Playbook.

## 2026-07-23 — Sell-readiness pass: self-serve signup, free trial, plan picker + polish

A three-angle audit (courier workflow/onboarding, UX polish, backend integrity) confirmed the core courier loop, multi-tenant/permission/timeline discipline, Stripe plumbing, and DriverOS offline are all solid. The gaps were concentrated in the *sales on-ramp*, now closed.

- **Self-serve signup UI.** `POST /v1/companies` already provisioned a company + admin, but nothing in FleetHQ called it — a prospect could only *sign in*. Added a `/signup` page (company + admin, optional email, password confirm) wired through a new `AuthProvider.signup`, and a "Create your company" link from the login screen. This is the missing "10 minutes to first value" on-ramp.
- **Native free trial.** New `Company.trialEndsAt` (migration `20260723160000_company_trial`); self-serve signup starts a 14-day trial (`TRIAL_DAYS`). A new `TRIAL_TIER` (every feature, 25 assets/operators) is granted while `now < trialEndsAt` via `resolvePlanTier`, then falls back to Free. Independent of Stripe's own TRIALING status — no card required. `/billing/entitlements` and `/billing/status` now report `trialActive` / `trialEndsAt` / `trialDaysLeft`, surfaced as a persistent AppShell trial banner and a Billing-page countdown → the conversion moment.
- **In-app plan picker.** New `GET /v1/billing/plans` returns the three purchasable tiers (Starter/Pro/Enterprise) with features, limits, configured Stripe price id, and a `purchasable` flag. The Billing page now renders all three as cards with a per-tier Subscribe button (was a single hardcoded `VITE_STRIPE_PRICE_ID` button), marks the current plan, and keeps the Stripe portal for management.
- **Operational email digest fix.** `sendDigest` addressed `username` (a login handle) instead of the user's real `email` — SES would have been handed a non-inbox. Now it sends to `email` and skips recipients without one (their in-app + push notifications still land). *Note:* the digest is still triggered manually via `POST /notifications/digest/send`; wiring a scheduler is a deployment concern, tracked separately.
- **Polish.** Branded 404 catch-all in both apps (was React Router's raw error page); DriverOS "Today" header now wraps instead of overflowing on a phone; first-run empty-state CTAs on Fleet/Operators/Dispatch guide the very first action; deleted the orphaned `ComingSoonPage`; corrected stale `severity` comments left after the maintenance-severity removal.
- e2e added for the signup trial, `billing/plans` (+ permission gate). Full API suite + both frontends (tsc/oxlint/vite build) green.

## 2026-07-23 — Dashboard widgets go live + the Impact page + AU vehicle quick-fill

Three "coming soon" dashboard cards became real, the office got a benefit-story page, and adding a vehicle got faster.

- **Upcoming Maintenance, Recent Activity, Fleet Graph** — the three placeholder dashboard widgets now render live data. Upcoming Maintenance reuses `GET /v1/maintenance-schedules/plans` (overdue/due-soon counts + the next few due, each linking to its asset). Two new company-wide read endpoints back the others: `GET /v1/timeline/recent` (a cross-entity activity feed, `timeline:view`) and `GET /v1/graph/summary` (a Fleet Graph roll-up — live-link count, linked assets/operators, breakdown by relationship type, most-connected assets, `fleet_graph:view`). The `PlaceholderWidget` component is retired.
- **Impact page** (`/impact`, `reports:view`) — answers "how beneficial has FleetOS been." New `GET /v1/reports/impact` returns a month-by-month series (deliveries delivered/failed, delivery + on-time rates, pre-start checks, maintenance cost) plus headline totals (deliveries proven, on-time %, checks completed & clean-pass %, faults tracked to closure, maintenance cost tracked, fleet under management) since first activity. FleetHQ renders it with dependency-free, theme-aware SVG charts (stacked bars + a multi-line percentage trend) and a CSV export — the app still ships no charting library.
- **Australian vehicle quick-fill** — the asset form gained a Make → Model → Year quick-fill picker backed by a broad catalogue of makes/models available on Australian roads (biased toward courier vans/utes/light-and-heavy trucks, mainstream passenger too). Every field stays free-text, so anything not listed can still be typed. Asset names were already links to the detail page; make/model/year already existed on the record.
- e2e added for `timeline/recent`, `graph/summary`, and `reports/impact` (shape, tenant activity, and permission gates); full API suite + both frontends (tsc/oxlint/vite build) green.

## 2026-07-23 — Universal GPS tracker ingest

The live map no longer depends on a driver's phone. Any GPS source — a hardware tracker, an OBD/telematics hub, a provider webhook — can now report an asset's position through a single universal ingest endpoint. Spec: `03-Hardware/GPS_Ingest.md`.

- New `GpsDevice` (registered tracker with its own secret `deviceKey`, optionally bound to an asset) and append-only `GpsPing` breadcrumb. Deliberately service-layer-scoped rather than RLS-protected, because ingest resolves the tenant *from the key* before any company context exists.
- `POST /v1/gps/ingest` is public and authenticates purely by device key — `{ deviceKey, lat, lng, … }`. Device registry (register/rename/bind/rotate-key/archive) is gated by a new `gps_device:manage` permission; the key is shown once. `GET /v1/gps/positions` feeds the map.
- FleetHQ: a "GPS trackers" tab under Fleet (register, copy key, bind to asset, rotate, remove), and the Live Map now renders hardware positions alongside driver-phone dots — so a tracked asset shows even when no driver is on shift.
- e2e covers register → ingest-by-key → map position, unknown-key rejection, tenant isolation, and the permission gate.

## 2026-07-23 — Customer-definable asset categories

Asset categories are no longer locked to Land/Air/Sea. The fixed `AssetClassKey` Postgres enum is gone; `AssetClass` is now a row with an optional `companyId` — `null` rows are the shared built-ins (Land/Air/Sea, usable by every company), and a company can add its own (Reefer, Van, Forklift, Vessel…), each able to back its own checklists/inspections. RLS scopes reads to "built-ins + own" and writes to "own", so categories never leak across tenants; keys are unique among built-ins and per-company.

- New `asset-classes` module: `GET /v1/asset-classes` (built-ins + own), plus create/rename/archive gated by a new `asset_class:manage` permission (archive is blocked while assets still reference the category). Category addressing stays key-based, so imports and existing callers keep working; the asset form also accepts a category `id` from a picker.
- The old "only LAND is implemented" gate is removed — every category (including Air/Sea) is usable.
- FleetHQ: a "Categories" tab under Fleet to manage custom categories; the asset form, checklist-template form, and checklist-bundle deploy all now fetch the live category list instead of hard-coding Land/Air/Sea.
- e2e covers list/create/in-use-archive-guard/tenant-isolation; migration + all affected suites green.

## 2026-07-23 — Founder feedback pass: simplify, and open assets up

A round of changes driven directly by founder review — removing abstractions that read as gimmicks, making core courier surfaces more discoverable, and enriching the asset record.

- **Dashboard "Getting Started" widget removed.** Onboarding checklist card taken off the dashboard (backend widget-catalog entry gone too).
- **Multi-drop runs are now discoverable.** The feature was already fully built (stops, CSV manifest import, DriverOS), but the create-job form said nothing about drops. The form is now framed as a run ("Create & add stops"), creating a job auto-opens the stop builder, and the row action is promoted ("+ Add stops"). No schema/API change.
- **Live map explained.** The empty state now diagnoses exactly why no vehicles show (driver signed in? shift started? location allowed? served over https?) so operators self-serve instead of assuming the site is broken — plus a pointer to hardware GPS trackers.
- **Customers now have a logged delivery history.** `GET /v1/customers/:id/deliveries` returns each customer's past stops (outcome, date, job, recipient/failure reason, POD), derived from existing JobStop records. FleetHQ shows a "Deliveries" drawer per customer.
- **Assets: specs, custom fields, and a real detail page.** Assets gained make/model/year/VIN/registration/odometer plus a free-form `customFields` JSON. The app's first parameterised route (`/fleet/:assetId`) opens an asset detail page — odometer + open-maintenance + compliance + checklist at a glance, a specs grid, per-section activity lists, and the full asset timeline. Clicking an asset opens it.
- **Fleet Health Score removed.** The 0–100 asset score, its page, dashboard widget, AI-hub card, and `GET /v1/fleet-health` endpoint are gone — it read as a gimmick and hid the actionable facts behind a number. The underlying signals it aggregated (overdue maintenance, expiring compliance) are still surfaced directly where they're useful (asset detail, Dispatch assign warning, Operational Recommendations, Reports uptime). `Fleet_Health_Score.md` is marked removed.
- **Maintenance severity removed.** The Normal/Critical flag is dropped (DB column + enum migrated out). Dispatch still warns before assigning an asset with *any* open maintenance job; Operational Recommendations' maintenance-priority now ranks by fault age + current utilisation; Reports uptime treats any open fault as out-of-service.
- **Demo company seed.** `npm run seed:demo` provisions a realistic 6-month company (10 spec'd assets, 120 multi-drop runs / 900 stops, maintenance + compliance history). Login `admin@rapid` / `fleetos-dev-password`.

## 2026-07-23 — More Saved Layouts: notification presets, dashboards, checklist bundles, address books

Four more surfaces adopted the "Saved Layout" pattern (`13-UI-UX/Saved_Layouts_Pattern.md`) — configure once, reuse many — and the API dev server was made robust on Windows.

- **Notification-preset bundles** (`notifications:manage`) — `NotificationPreset` saves a company member's per-type mute list + digest-only flag and **deploys to many users** at once. FleetHQ: a "Notification presets" tab under Administration.
- **Dashboard layout presets** (`dashboard:manage`) — `DashboardLayoutPreset` saves the current dashboard widget arrangement (with an optional company default) and deploys it to any number of users' dashboards. FleetHQ: a "Dashboards" tab under Administration.
- **Checklist/inspection bundles** (`checklists:edit`) — `ChecklistBundle` groups checklist templates; deploying scopes every member template to a chosen **asset class** in one action, so a whole pre-start/inspection set lands on (say) every LAND asset at once. FleetHQ: a "Bundles" tab under Checklists.
- **Depot/customer address books** (`address_book:manage`) — `AddressBook` saves this company's depots + customers as a named, portable payload. A multi-entity operator **exports** the book, **imports** the JSON into another company they run, and **applies** it to populate that company's depots/customers (idempotent by name). The book row always lives in the owning company — only the payload crosses the tenant boundary, so RLS isolation holds. This cross-company variant is now documented in the pattern doc. FleetHQ: an "Address books" tab under Administration.
- **Fix — API dev server no longer races itself on Windows.** `npm run dev` ran `nest start --watch`, which with `deleteOutDir: true` wiped and rebuilt `dist/` on every change; the Windows runner could `require('dist/main')` mid-rebuild and crash with `Cannot find module`, so the API never bound and FleetHQ's proxy returned 502 on login. `dev` now runs straight from TypeScript via `ts-node` (no `dist/` to race); the old watch behaviour stays available as `dev:watch`.

## 2026-07-23 — Customer-configurable compliance & maintenance, as savable/deployable layouts

Two customer-tunable systems became fully configurable, and both use the same reusable "Saved Layout" pattern — configure once, deploy to many.

- **Driver-fatigue rules are now customer-customizable.** The AU Standard Hours engine was refactored into a parameterized factory, and a new `FatigueRuleSet` entity lets a company save its own work/rest limits (24h/7-day max-work, min-rest, plus the "approaching" warning margin). A rule set can be made the company default or **deployed to any number of operators** in one action. Resolution: operator's assigned set → company default → built-in jurisdiction default. FleetHQ: a "Fatigue rules" tab under Compliance.
- **Asset health now accounts for scheduled maintenance.** New `MaintenanceScheduleTemplate` (a savable schedule of recurring service items, seedable from light/heavy-vehicle presets) **deploys to many trucks at once**, materialising per-asset `AssetMaintenancePlan` rows (idempotent). A new health factor deducts for overdue/due-soon plans, so the Fleet Health score and the AI hub reflect missed service; a one-tap "Mark serviced" resets the clock. FleetHQ: a "Schedules" tab under Maintenance.
- **`13-UI-UX/Saved_Layouts_Pattern.md`** codifies the shared pattern (a company-scoped template entity + an idempotent deploy action + a resolution fallback order) so every future customer-configurable feature is consistent. Documents where it's implemented (Forms, Checklists, Fatigue rules, Maintenance schedules, Roles) and the next candidate surfaces.

## 2026-07-23 — Feature expansion: Live Map, Warehouse add-on, DriverOS app, UI refresh

- **Live Map** — a dedicated GPS page showing every road unit's live position at once (markers labelled by the assigned truck, colour-coded by freshness/on-shift, click-to-focus roster, 10s auto-refresh). The `/v1/locations` fleet view was enriched with each operator's active-job unit and on-shift flag.
- **Warehouse add-on** (paid) — stock inventory (custom fields, quantity adjust, low-stock, paste-CSV bulk import) and floor machines with maintenance/monitoring logs. Billing gates only UI *promotion*; data entry and import are never blocked, per the brief.
- **DriverOS as a downloadable app** — Capacitor config + scripts wrap the existing PWA into App Store / Play Store binaries, documented in `04-DriverOS/App_Packaging.md` (PWA-install, Capacitor, and TWA paths).
- **2026 UI refresh** across both apps — cool-tinted surfaces, an electric-indigo + cyan accent pairing used sparingly for glow/gradient, soft elevation, blurred translucent chrome, motion, and Inter stylistic sets; applied through the shared token system and high-traffic components so every screen lifts at once.

## 2026-07-23 — Documents, Knowledge Base & AI: the last three "Coming Soon" modules go live

The three remaining stubbed FleetHQ nav modules are now real, full-stack features. No nav item renders "Coming Soon" any more.

- **Documents** (`documents:view/create/archive`): a flat, categorised company file library for office paperwork that isn't asset- or operator-scoped (policies, contracts, templates, licences) — distinct from Compliance (expiry semantics) and the per-asset Digital Glovebox. New `Document` model + RLS migration; bytes reuse the shared Attachment store (Postgres-inline or S3 by config). Upload (base64 data URL), category/search filter with a distinct-categories rollup, metadata edit, archive, and authed byte download. FleetHQ page: searchable, category-chip-filtered library. e2e-covered.
- **Knowledge Base** (`knowledge:view/create/archive`): a searchable library of authored articles / SOPs in markdown, distinct from Documents (uploaded files). New `KnowledgeArticle` model + RLS migration with draft/published status. **Draft privacy** — drafts are visible only to authors (`knowledge:create`); plain viewers see published articles only, enforced in both list and single-fetch. FleetHQ page: card grid, search, category chips, reader drawer, and a Write/Preview markdown editor (Save-as-draft vs Publish). Rendering uses a dependency-free, XSS-safe markdown renderer (builds React elements, never `innerHTML`). e2e-covered (author→publish→read→filter→archive, draft hiding, permission gate).
- **AI / Fleet Intelligence hub**: a command centre unifying every signal FleetOS already computes into one "what needs my attention" view — predictive maintenance, maintenance priority, asset health, and driver-fatigue risk — each card deep-linking to the module that owns the detail. Every section is permission-gated and only queried when the user can see that data; a headline banner sums the total signals needing attention. Frontend-only, composed from the existing intelligence endpoints.
- New permissions flow automatically to the right roles: company provisioning grants Administrator all of them and Read Only the `:view` ones, and the seed's reconcile step back-fills them onto existing companies' template roles — no seed edit needed.

## 2026-07-23 — Launch readiness A1: go-live runbook + deploy wiring

The code/config half of go-live (`17-Roadmap/Launch_Readiness_Plan.md` A1) — everything short of provisioning against a real AWS account, which only the founder can do.

- **`16-Deployment/Go_Live_Runbook.md`**: the end-to-end sequence — provision (staging first) → create the GitHub↔AWS OIDC deploy role → wire the GitHub deploy variables (with a Terraform-output→variable mapping table) → first deploy + smoke test → fill the secret placeholders (SES/Stripe/Sentry/VAPID) → add a domain → production → rollback. Ties together the existing `infra/README.md`, the api-service bootstrap, and the two deploy workflows.
- **Deploy wiring fixed** (found while writing the runbook): the ECS task definition didn't pass the A2/A3 runtime env, so a prod deploy would have shipped **broken email links** and no billing enforcement. The `api-service` module now passes `APP_BASE_URL` (auto-derived from the managed FleetHQ domain), `BILLING_ENFORCED`, and `STRIPE_PRICE_*`, threaded through `environments/base` + tfvars. Added the deploy-variable outputs the workflows read but base didn't expose (`db_address`, `cloudfront_distribution_id_fleethq/driveros`). `terraform validate` passes.

## 2026-07-23 — Launch readiness A4: hardening tie-offs (restore drill, PII redaction, ops runbook)

The pre-sale operational proofs from `17-Roadmap/Launch_Readiness_Plan.md` — turning "configured" into "verified".

- **Backup restore drill** (`apps/api/scripts/restore-drill.sh`): dumps the live DB, restores it into a throwaway scratch DB, and verifies the copy matches the source row-for-row on the key tables, then drops the scratch DB (source untouched). **Run and verified** against the local database — dump→restore→row-count match all green. Complements the infra snapshot/cross-region DR layer with a proven *logical* restore.
- **Log PII redaction tightened**: the pino config now redaction-removes cookies and common secret keys (`password`, `passwordHash`, `newPassword`, `token`, `tokenHash`) at the log root and one level down, on top of the existing `Authorization` redaction.
- **`14-Security/Production_Operations.md`** runbook: how to run the restore drill and load harness, the DB-role/secret rotation procedure (the existing `rotate-db-role-passwords.ts` + Secrets Manager), the log-PII policy, and the status/uptime plan (deferred to go-live).

## 2026-07-23 — Launch readiness A3: plan tiers + entitlement enforcement

Closes the "nothing enforces plans" gap from `17-Roadmap/Launch_Readiness_Plan.md`: Stripe could take a subscription, but every company could use every feature and add unlimited records regardless.

- A **plan catalog** (`billing/plans.ts`) — Free / Starter / Pro / Enterprise — each with a feature set and operator/asset limits; `resolvePlanTier` (pure, unit-tested) maps a company's `subscriptionStatus` + `planPriceId` to a tier, keeping entitlements through the `PAST_DUE` grace window and falling back to Free for none/cancelled/unmatched.
- **`EntitlementsService`** resolves a company's effective entitlements and enforces limits. Enforcement is gated by **`BILLING_ENFORCED`** — off by default so dev/CI/pilot stay unlimited and nothing existing breaks; on, a company past its plan's operator/asset limit gets **402 `PLAN_LIMIT_REACHED`** at creation. The nominal plan is always reported for display.
- **`GET /v1/billing/entitlements`** (no permission gate, like `/auth/me`) exposes plan/features/limits so the client can gate UI; FleetHQ's Billing page shows the current plan + limits when enforcement is on.
- Price ids map to tiers via config (`STRIPE_PRICE_STARTER/PRO/ENTERPRISE`). Unit + e2e tests (limit enforced on Starter, Free fallback).

## 2026-07-22 — Launch readiness A2: auth completeness (verify, reset, invite, lockout)

Closes the pre-sale auth gaps from `17-Roadmap/Launch_Readiness_Plan.md`: login + signup existed, but there was no email verification, no password reset, and no brute-force protection.

- **User** gains `email` + `emailVerifiedAt` and lockout counters (`failed_login_count`, `locked_until`). New `AuthToken` table stores only the **SHA-256 hash** of single-use, expiring tokens (a DB leak can't be replayed), touched only by the BYPASSRLS `fleetos_auth` role via column-scoped grants — the login path already runs there, before any tenant context.
- **Endpoints** (all public, throttled): `forgot-password` (always `{ok:true}` — no account enumeration), `reset-password`, `verify-email`, `resend-verification`. A completed reset also verifies the email and clears the lock.
- **Login lockout**: 5 consecutive failures locks the account for 15 min; the lock is checked before the password (flat timing), and clears on the next success. A completed reset also unlocks.
- **Signup** now takes an optional `adminEmail` and sends a verification email; **user invite** — omit the password on user-create to create the login disabled and email a "set your password" link (reuses the reset token). Emails go through the existing `NotificationChannel` (real SES when configured, logging otherwise), with links built from `APP_BASE_URL`.
- **FleetHQ**: a "Forgot your password?" link plus `/forgot-password`, `/reset-password`, and `/verify-email` public pages.
- e2e: verify, reset (single-use + no-enumeration), invalid-token, and lockout. All green.

## 2026-07-22 — Multi-parcel per stop + barcode scan (courier depth)

A delivery stop can now carry multiple parcels, so a run tracks "3 of 4 parcels scanned" instead of being all-or-nothing. New `StopParcel` model (RLS-scoped, no hard deletes), nested on the job's stops. Endpoints: `POST /v1/jobs/:id/stops/:stopId/parcels` (office pre-lists from a manifest, `dispatch:edit`), `POST .../parcels/scan` (driver scans, `dispatch:deliver` — upserts by reference, so scanning a parcel the office didn't list adds it, and re-scanning is idempotent), `GET .../parcels`. DriverOS's Record-delivery screen gets a scan field (works with keyboard-wedge depot scanners and manual entry) with a live scanned/total and optimistic, offline-queued scans. FleetHQ's stops dialog shows each stop's parcels + scanned/total and lets the office add parcels. Optional per stop — a stop with no parcels behaves exactly as before. e2e added. (Camera-based barcode capture via `BarcodeDetector` is a noted future enhancement; the scan field already covers hardware scanners.)

## 2026-07-22 — Visual map on the dispatch board

Upgrades the "Live driver locations" panel from a list to an actual map: `FleetMap` (Leaflet + OpenStreetMap tiles, no API key/provider account) plots each on-shift driver as a marker with a popup (name, job/asset, last-seen), auto-framed to the fleet. Uses CircleMarkers so there are no marker-image assets to bundle. Degrades honestly — if the office is offline the tiles just don't load and the markers sit on a blank canvas, and the textual list stays rendered underneath so the information is never map-only. This closes `05-Dispatch/Dispatch_Overview.md`'s "live map view" line the location feed enabled.

## 2026-07-22 — Printable Proof-of-Delivery receipt (PDF)

Turns a completed stop's already-captured POD (recipient, note, outcome, timestamp, photo, signature) into a one-click PDF receipt — the natural export of data the delivery flow already stores, for a dispute or a customer who asks for proof. `GET /v1/jobs/:id/stops/:stopId/receipt` (gated by `dispatch:view`) renders it with `pdf-lib`, embedding the delivery photo and signature; a stop with no proof yet is refused with `STOP_NOT_COMPLETED`. FleetHQ's stops dialog gets a "Download receipt" button on each completed stop. A corrupt/unsupported image is skipped rather than sinking the whole receipt (the text proof is what matters). Internal/fleet-facing only — a dispatcher-downloaded document, not a customer-facing proof portal (`CLAUDE.md` scope). e2e added.

## 2026-07-22 — Dispatch board: live auto-refresh + concurrent-reassignment safety

Two dispatch-robustness gaps from `05-Dispatch/Dispatch_Overview.md`, together.

- **Auto-refreshing board**: the FleetHQ jobs list now polls (30s) and re-syncs on window focus, so a driver completing a stop or another dispatcher reassigning a job appears without a manual refresh — matching the now-live locations panel.
- **Concurrent-reassignment conflict detection** (`Dispatch_Overview.md`'s edge case): `POST /v1/jobs/:id/assign` takes an optional `expectedUpdatedAt` optimistic-concurrency token. If the job changed since the dispatcher loaded it (another dispatcher reassigned it, or a driver completed a stop), the assign is rejected with `JOB_MODIFIED` and the current job returned, instead of silently clobbering the newer state. FleetHQ's assign dialog sends the token and, on conflict, refreshes the board and tells the dispatcher to re-check before reassigning. Omitting the token keeps the previous last-write-wins behaviour, so nothing else breaks. e2e added.

## 2026-07-22 — Live driver location + in-app navigation (courier vertical: "where is my driver now")

Closes the top item on `05-Dispatch/Dispatch_Overview.md`'s not-built list — the marquee office-visibility gap — using the DriverOS client as the GPS source instead of waiting on OBD telemetry, plus the smallest daily driver win alongside it. Three layers, all zero-config and offline-tolerant:

- **API**: `Operator` gains `last_lat/last_lng/last_location_at` (migration `20260722234500_operator_live_location`). New `LocationsModule`: `POST /v1/locations` (a linked Operator reports its own position; validates real WGS84 ranges) and `GET /v1/locations` (the office reads the fleet's last-known positions within a 12-hour live window). Only the latest fix is kept — live telemetry, **no** Timeline event (a position a minute would drown the audit log), and no breadcrumb table (YAGNI until a route-history feature needs one). New granular permissions `locations:report` / `locations:view` so GPS visibility is independently grantable from the dispatch board. 5 e2e tests (report+view, no-linked-operator reject, out-of-range reject, permission gate, tenant isolation).
- **DriverOS**: a **"Navigate to this stop ↗"** link on the next-stop card and Record-delivery screen opens the device's maps app (no embedded map — a hand-off, kept simple and provider-free). While on shift, `useLocationReporter` reports geolocation on a ~45s heartbeat — best-effort, non-blocking, secure-context-only, and deliberately **not** outbox-queued (a stale replayed position is worse than none).
- **FleetHQ**: an auto-refreshing "Live driver locations" panel on the Dispatch page — name, last-seen time-ago (flagged stale after 5 min), correlated job/asset, and an open-in-maps link. Renders only when someone is on the road and only for `locations:view` holders.

Privacy: device position is personal information — export includes the last-known fix and erasure clears all three columns (`14-Security/Privacy_Data_Protection.md` updated). Verified: full API e2e suite green, both frontends build/lint/test green.

## 2026-07-22 — Privacy: erasure now deletes S3-stored scans too

Follow-on to the S3 attachment work, caught during verification. The Privacy Act erasure path zeroed the Postgres `data` column, but a scan stored in S3 has that column null — so an erasure would have left the actual licence/medical scan sitting in the bucket. Fixed: `PrivacyService.eraseOperatorData` now deletes the S3 object (and clears `storageKey`) for any erased attachment that lives in S3, alongside zeroing inline bytes. Added `AttachmentStorage.remove()`. Privacy e2e suite still green (inline path); `14-Security/Privacy_Data_Protection.md` updated.

## 2026-07-22 — S3 attachment storage (behind config), Postgres-inline remains the default (`apps/api` + `infra/`)

Delivers the "deploy-time swap to object storage" the Attachment model always anticipated — so real photo/scan volume (POD photos, fault photos, licence scans) doesn't bloat the database, without forcing that infra on a pilot.

- **`AttachmentStorage`** (`apps/api/src/attachments/attachment-storage.ts`) puts/gets bytes in S3; `AttachmentsService` chooses the backend by config (`ATTACHMENTS_BUCKET`): S3 when set, inline Postgres bytes otherwise (the historical default). Schema: `Attachment.data` is now nullable and a `storageKey` column added — exactly one is set per row (migration `attachment_s3_storage`), so a deployment can use either **and old inline rows keep working** even after a bucket is configured (download reads from the row's own `storageKey`, not the current config). The S3 put happens before the row insert, so a rolled-back transaction can only orphan an object (lifecycle-cleanable), never leave a row pointing at nothing.
- 2 new unit tests prove the backend branch (S3 configured → object key stored, `data` null; unconfigured → inline bytes, no key); the full attachment/POD/glovebox e2e suites (15 tests) still pass on the default inline path.
- **Terraform**: when `enable_attachments_bucket = true`, creates a private, KMS-encrypted, versioned, public-access-blocked S3 bucket, points the app at it (`ATTACHMENTS_BUCKET` env), and grants the ECS task `s3:GetObject`/`PutObject` scoped to **only that bucket's objects**. Default false keeps attachments inline and creates no bucket. `terraform validate` passes.

## 2026-07-22 — Real outbound email (AWS SES channel), flip-a-switch ready (`apps/api` + `infra/`)

Delivers on the `NotificationChannel` abstraction's original "swap in a real provider later" promise — until now the only implementation was `LoggingNotificationChannel`, so notification digests emailed nobody.

- **`SesNotificationChannel`** (`apps/api/src/notifications/channels/`) sends real email via AWS SES. `NotificationsModule` now chooses the channel by config: SES when `EMAIL_PROVIDER=ses` + a verified `EMAIL_FROM_ADDRESS` are set, the logging channel otherwise — so local dev, CI, and an un-provisioned deploy all keep working with zero email config. Credentials/region come from the standard AWS sources (the ECS task role in production; `AWS_REGION`/profile locally). SMS stays logging-only (no SMS need has surfaced).
- 3 unit tests against a mocked SES client (builds the right `SendEmailCommand` from the configured From address + recipient/subject/body; propagates send failures; SMS is a no-op). Full notifications e2e suite still green.
- **Terraform made it genuinely flip-a-switch**: the api-service task definition now sets `AWS_REGION` and, when `email_from_address` is configured, `EMAIL_PROVIDER=ses` + `EMAIL_FROM_ADDRESS`; and a conditional, tightly-scoped IAM policy grants the ECS task `ses:SendEmail`/`SendRawEmail` **only for the configured From address** (a `ses:FromAddress` condition), and only when email is turned on — so a deploy with email off keeps a permission-free task role. `terraform validate` passes.
- To go live: verify a From address (or domain) in SES in `ap-southeast-2`, set `email_from_address` in the environment's tfvars, apply. Nothing in the app changes.

## 2026-07-22 — Testability: PWA + offline app shell + local-run guide (`apps/driveros` + `apps/fleethq`)

Groundwork so the founder can actually run and install FleetOS on their own devices before selling. Two real gaps closed plus a run guide.

- **DriverOS now genuinely loads offline, and both apps are installable.** The prior offline design cached *data* (IndexedDB) but not the *app* — the service worker only did push, so an offline reload was a blank page, contradicting DriverOS's own "zero connectivity, login to end of shift" criterion. Both apps' `public/sw.js` now cache the app shell (runtime caching: navigations network-first → cached-shell fallback; static assets stale-while-revalidate; `/v1` + `/health` never cached), registered on startup (`src/lib/register-sw.ts`). Added a web app manifest + real PNG icons (192/512 + maskable, rasterised from the brand SVG) + apple-touch-icon so both install to the home screen as standalone apps. **Verified in headless Chromium**: with the SW controlling the page, an offline reload boots the app from cache instead of showing a blank page.
- **Local-testing HTTPS mode.** Service workers/PWA/push only work in a secure context (HTTPS or localhost). Added `npm run dev:lan` (HTTPS + `--host` via `@vitejs/plugin-basic-ssl`) so the apps can be reached over the LAN with a secure context for on-device PWA testing.
- **`RUNNING.md`** (new, repo root) — a plain-language guide for a non-expert to run the DB + API + both apps locally, and reach them from a tablet/phone on the same WiFi, with an honest note that full PWA-on-tablet wants a trusted cert (mkcert) or the real hosted deployment.

All three apps still build/lint/test clean.

## 2026-07-22 — Fix: DriverOS offline outbox could replay mutations out of order (`apps/driveros`)

Found during the final cross-app verification of the commercial-launch-readiness work — a genuine production bug, not just a test issue. DriverOS's offline outbox ordered queued mutations by a `Date.now()` `createdAt` timestamp, but several mutations queued within the same millisecond got identical timestamps; because the store's own key is a random UUID, the tie then resolved in random order, silently violating the "replay queued mutations in creation order" guarantee the offline sync (`04-DriverOS/DriverOS_Overview.md`) depends on. It surfaced when the full test suite ran the queue operations fast enough to collide on the millisecond. Fixed `queueMutation` to make `createdAt` strictly monotonic (step past the current max), which stays correct across app restarts because it's derived from persisted data rather than an in-memory counter. All 17 DriverOS unit tests now pass deterministically across repeated runs.


## 2026-07-22 — Commercial launch readiness, part 6: stale-doc sweep

Fixed documentation that had fallen behind the code as the courier vertical filled out — no code changes, just correcting docs that would mislead a reader (or a lawyer/founder) about what's built.

- **`04-DriverOS/DriverOS_Overview.md`**: the v0 note claimed "Smart Checklists, Messages, and AI Voice are not built yet." All three shipped, plus Universal Forms, shift start/end, proof-of-delivery/multi-stop delivery, notifications, a help screen, and the DriverOS test suite + CI. Replaced the stale line with an accurate account of what's now built.
- **`01-Product/Onboarding_Import.md`**: "Not built in this slice: Customer/Depot import" was stale — `POST /v1/imports/` now covers depots, customers, attached-units, and compliance-documents too. Added an update note; duplicate detection and AI column mapping remain the real open items.
- **`README.md`**: the "Phase 1 — Foundation: in progress" status line was long out of date. Replaced with an accurate summary — the courier vertical is feature-complete, commercial-launch-readiness work (infra/backups/monitoring/tests/CI/load/security/NHVR-review/billing/legal-drafts) is done, and what remains is external/human (independent pentest, transport-lawyer sign-off, standing up real production accounts).
- `PRODUCT_ROADMAP.md` and `FOUNDER_NOTES.md` were already updated in the billing commit to mark billing and disaster-recovery done.


## 2026-07-22 — Commercial launch readiness, part 5: legal document drafts (ToS, Privacy Policy, DPA)

Founder chose "prepare lawyer-ready drafts now" for the legal paperwork a real customer sale needs. New `20-Legal/` folder with three drafts plus a README. **Every document is explicitly marked DRAFT — PENDING AUSTRALIAN LEGAL REVIEW and must not be published, presented to a customer, or relied on in any contract until a qualified lawyer reviews it** — the engineering team is not a lawyer, and this work is stated as a starting point for that review, never a substitute for it.

- **`Terms_of_Service.DRAFT.md`** — the subscription agreement, including a clause making clear FleetOS's compliance features (fatigue/CoR/expiry) are decision-support tools and not legal advice or a compliance guarantee, aligned to `08-Compliance/NHVR_Compliance_Review.md`'s own caveats; the v1 "billing informs, doesn't hard-lock-out" position from `19-Billing/`; and Australian Consumer Law non-exclusion wording.
- **`Privacy_Policy.DRAFT.md`** — built around the actual controller/processor split from `14-Security/Privacy_Data_Protection.md` (FleetOS is a processor for operator data, the customer is the controller), Australian data residency (AWS ap-southeast-2), Stripe for payments (no operator data), and the APP 12/11.2 self-service export/erasure the product already implements.
- **`Data_Processing_Addendum.DRAFT.md`** — the processor-side terms a business customer expects, listing real sub-processors (AWS, Stripe) and describing the real security measures rather than boilerplate.
- Each draft carries inline **[DECISION NEEDED: …]** and **[LAWYER TO CONFIRM: …]** markers on every point that genuinely needs a human commercial or legal answer (governing-law state, legal entity/ABN, liability caps, GST treatment, breach-notification timelines, refund policy, uptime SLA) — so the reviewing lawyer and the founder can see exactly what's still open rather than mistaking a placeholder for a decision.

Documentation-only change; no code, no tests affected.


## 2026-07-22 — Commercial launch readiness, part 4: billing & subscriptions (`apps/api` + `apps/fleethq`)

Closes `FOUNDER_NOTES.md`'s gap #4 and `PRODUCT_ROADMAP.md`'s "Billing & subscription management spec" line. Full design + go-live checklist: `19-Billing/Billing_And_Subscriptions.md` (new folder). Part of the founder-directed commercial-launch-readiness push.

- **Stripe-backed subscriptions**, Stripe as source of truth: `Company` gains `stripeCustomerId`/`stripeSubscriptionId`/`subscriptionStatus`/`planPriceId` (migration `add_billing_subscription`), storing only the minimum FleetOS needs to show status without a Stripe round-trip. No card data, pricing, or dunning logic lives in FleetOS.
- **Endpoints** (`apps/api/src/billing/`): `GET /v1/billing/status`, `POST /v1/billing/checkout-session` (Stripe-hosted Checkout), `POST /v1/billing/portal-session` (Stripe Billing Portal), and a signature-verified `POST /v1/billing/webhook` that is the *only* writer of subscription state (Stripe, not the browser redirect, is authoritative on payment success). `main.ts` now enables `rawBody` so the webhook can verify Stripe's signature against exact bytes.
- **Two new permissions** under the existing "Finance" category — `billing:view` / `billing:manage` — auto-reconciled onto the Administrator system role.
- **FleetHQ Billing page** + nav item: subscription badge, past-due warning, Subscribe/Manage-billing buttons routing to Stripe's hosted flows, graceful "billing not configured" state, and manage-actions hidden without `billing:manage`. Live-tested in a real browser (renders, nav active, zero console errors).
- **v1 policy decision**: billing *informs* (status + banner) but does **not** hard-lock-out on non-payment — a safety-relevant operational tool abruptly locking a fleet out mid-shift over an expired card is a worse outcome than a few days' grace; the `subscriptionStatus` column already carries what a future graduated-enforcement milestone would need.
- **Not built / deliberately deferred**: no live Stripe account is created by this work (test-mode-complete; going live is config, not code — see the doc's go-live checklist), no metered/per-asset billing, no in-app invoice UI (the Stripe Portal covers it).
- **Two real fixes found while building, both documented in-code**: (1) `companies` is RLS-protected, so `BillingService` must query it via `withTenant` and resolve webhook events to a company via Stripe subscription `metadata.fleetosCompanyId` rather than a by-customer-ID lookup RLS forbids (found by live-testing, not review — it 500'd first); (2) patched a `multer` DoS-CVE version was already done in part 2, unrelated. Also raised the Jest hook timeout to 30s — with the suite now past ~48 files, the default 5s app-boot hook timeout flaked under serial contention though every suite passes in isolation.

7 new billing e2e tests (status, permission gating, checkout/portal not-configured errors, webhook signature rejection, status/plan sync, past_due→canceled mapping, unknown-company no-op); full API e2e suite (214 tests) green; both frontends build and typecheck; FleetHQ unit tests green.


## 2026-07-22 — Commercial launch readiness, part 3: NHVR/HVNL compliance deep-review

Part of the same founder-directed commercial-launch-readiness push as the previous two entries. Full findings and caveats: `08-Compliance/NHVR_Compliance_Review.md` — **read the status header on that document before treating anything here as a compliance guarantee; it is explicitly a draft pending transport lawyer review, not a certification.**

- Researched current Standard Hours rules (via web search, since this session's automated fetches of the primary legislative text — austlii.edu.au, legislation.nsw.gov.au, nhvr.gov.au — were blocked with HTTP 403) and compared them against the fatigue engine built earlier this project (`apps/api/src/compliance/jurisdiction/au-fatigue-rules.ts`).
- **Found and fixed a real gap**: the existing three checks (12h work/24h, 7h rest/24h, 72h work/7d) let an operator pass every check while still working a full week with no real day off — Standard Hours also requires 24 continuous hours of rest somewhere in every 7-day period, a distinct rule from "72h work max." Added as a fourth check, same pattern as the existing three (constants in one file, `ok`/`approaching_limit`/`breach` status, surfaces through the same dashboard/assign-warning/DriverOS-card plumbing with zero UI changes needed).
- **Found and documented, not fixed**: several more granular real rules the research surfaced that remain unmodeled — sub-shift rest-break cadence at 5.5h/8h/11h work windows, the specific 10pm-8am night-rest-break timing definition, a 4-night-rest-breaks-per-14-days pattern requirement, and graduated minor/substantial/severe/critical breach severity tiers used in real NHVR enforcement. See the review doc for the full list and reasoning on why these are flagged rather than implemented blind.
- 1 new e2e test (the new 7-day-rest breach, isolated from the pre-existing three checks); all 12 pre-existing fatigue tests re-verified to still pass with the new rule active (manually confirmed none of their fixtures' shift patterns would false-trigger it).
- Updated `Australian_Compliance.md`'s implementation notes to reflect the fourth check and point at the new review doc.

Full e2e suite (207 tests, 47 suites) green; both frontend builds (`fleethq`, `driveros`) still typecheck clean against the widened `OperatorFatigueStatus` type.

## 2026-07-22 — Commercial launch readiness, part 2: security self-review and hardening

Part of the same founder-directed commercial-launch-readiness push as the infra/monitoring/testing entry below. Full findings: `14-Security/Security_Review.md`.

- **Fixed**: `HttpExceptionFilter` no longer echoes a raw, unhandled exception's `.message` to the client (only an app-authored `HttpException`'s message is ever safe to return) — closes an information-disclosure gap that could leak internal error details (schema names, driver errors) to any client hitting a genuine bug.
- **Fixed**: added `@nestjs/throttler` — no rate limiting existed anywhere before this. A generous app-wide default (300 req/min/IP) plus a tight override (10 req/min/IP) on the three unauthenticated credential-checking endpoints (`auth/login`, `auth/select-company`, `companies` signup). Verified live against the built app (not just config inspection): 14 rapid login attempts returned `401` for the first 10, `429` from the 11th.
- **Fixed** (found while verifying the above): the app had no `trust proxy` setting, so in production every user behind the ALB would have shared one rate-limit bucket — one user's traffic could throttle everyone else's. Added `app.set('trust proxy', 1)`; verified distinct `X-Forwarded-For` values now get independent buckets.
- **Fixed**: `multer` (a production, request-path dependency for file/photo uploads) was pinned at a version with four known DoS CVEs by `@nestjs/platform-express`; patched via an npm `overrides` entry to `2.2.0` without needing to bump the parent package.
- Reviewed and found already adequate: SQL injection surface (Prisma parameterized throughout), mass assignment (global `ValidationPipe` whitelist), password policy, JWT handling, CORS (deliberately omitted — same-origin by design), CSRF (n/a, bearer-token auth), secrets-in-logs, security headers, request size limits, and multi-tenant row-level-security isolation.
- Remaining `npm audit` findings reviewed individually and left as-is with reasoning recorded (mostly devDependency-only, never shipped in the production image) — see the doc for the one accepted exception (`tar`, transitive through `bcrypt`'s native-binary installer, install-time-only code path).

Full e2e suite (206 tests, 47 suites) green after every change in this entry.


## 2026-07-22 — Commercial launch readiness, part 1: infrastructure, monitoring, tests, load testing

Founder directive: get v1 to "a completed working product to sell to real companies," not a feature demo — see `00-Company/Commercial_Priority.md`'s own "then sell" exit condition. This is an explicit, one-time, founder-directed exception to that file's "finish before deploying" default, made because the courier feature set (dispatch → drive → deliver → prove → office visibility, plus reporting/compliance/intelligence) is now built end-to-end and the risk that remains is operational (a production failure costing the founder real money), not a missing feature.

- **Production AWS infrastructure as code** (`infra/terraform/`): a `base` root module (network/database/secrets/api-service/frontend/monitoring child modules) deployed once per environment via tfvars, sized for rapid horizontal scaling — ECS Fargate behind an ALB with dual autoscaling (CPU + request-count-per-target), RDS Postgres Multi-AZ with KMS encryption and storage autoscaling, S3+CloudFront for both SPAs (with a `/v1/*` CloudFront origin routed to the ALB, since both frontends assume same-origin API calls). Region: `ap-southeast-2` (Sydney), for Australian data residency. `terraform validate` passes on all modules.
- **Backups & disaster recovery** (`infra/terraform/modules/database/`): automated RDS backups with point-in-time recovery, plus a Lambda+EventBridge job copying snapshots cross-region (`ap-southeast-2` → `ap-southeast-4`) for whole-region DR. `README.md` documents explicit RPO/RTO figures and both restore runbooks (point-in-time and whole-region).
- **Monitoring & alerting**: CloudWatch alarms (ECS CPU/task-count, ALB 5xx/latency/unhealthy-hosts, RDS CPU/storage/connections) via SNS (`infra/terraform/modules/monitoring/`) for infrastructure-level issues, plus Sentry (`@sentry/node`/`@sentry/react`) wired into the API's global exception filter (5xx only) and both frontends' error boundaries for application-level error tracking — two distinct, complementary layers.
- **Frontend automated test suites**: fleethq's existing-but-unused Vitest setup finally has real tests (`usePermissions`, `LoginPage`). driveros had zero test infrastructure — built from scratch (Vitest + Testing Library + `fake-indexeddb`), including the offline-sync engine and IndexedDB outbox (`offline-db.spec.ts`, `sync-engine.spec.ts`) that `08-Compliance/Testing_Strategy.md` had called for but nothing had implemented yet. New `fleethq-ci.yml`/`driveros-ci.yml` GitHub Actions (lint → build → test) alongside the existing `api-ci.yml`, plus `deploy-api.yml`/`deploy-frontends.yml` (OIDC-authenticated, `workflow_dispatch`-only).
- **Load testing** (`apps/api/scripts/seed-load-test-data.ts`, `load-test.ts` — `npm run load-test:seed` / `npm run load-test`, autocannon): seeded a 500-asset/1,000-job/400-maintenance-job company and load-tested the busiest read endpoints. Found and fixed two real issues rather than just reporting green numbers — see `02-Architecture/Scaling_And_Enterprise_Readiness.md`'s new "Load testing — findings" section for the detail: (1) Prisma's default connection pool was queuing requests under concurrency well before the DB was actually the bottleneck (fixed: explicit `connection_limit` on the Prisma connection strings, sized against the RDS instance's `max_connections`); (2) `GET /v1/fleet-health` was serializing multiple permission-check DB round trips it didn't need to (fixed: batched into one query, run concurrently with the main asset query) — and separately, documented (not fixed, not yet triggered) that the endpoint's per-asset, unpaginated response is inherently CPU-bound at large fleet sizes, with a stated trigger for when to actually paginate it.
- Also rotates the three RLS-role dev-only passwords the Prisma migrations hardcode for local development (`apps/api/scripts/rotate-db-role-passwords.ts`, `npm run db:rotate-role-passwords`) — every real deployment must run this, since shipping with `fleetos_app_dev_only` etc. live would mean every FleetOS install (and this repo, being public) shares the same database credentials. Verified against a live local Postgres (rotated, confirmed old password rejected, new one accepted, then reverted so the sandbox stays usable) before being treated as safe to document.

Full e2e suite (206 tests, 47 suites) still green after these changes.

## 2026-07-22 — Parts inventory basics (`apps/api` + `apps/fleethq`)

`06-Workshop/Workshop_Overview.md`'s "Future expansion notes" line ("parts inventory management ... is a natural extension once core workshop workflow is proven") and `17-Roadmap/Product_Roadmap.md`'s v1.x "parts inventory basics in Workshop" line.

- **New `Part` catalog** (`apps/api`): name, optional part number, `quantityOnHand`, optional `unitCost`, optional `lowStockThreshold`, mirroring the Depot/Customer reference-record CRUD-plus-archive shape. New `parts:view/create/edit/archive` permissions, auto-reconciled onto the Administrator/Read Only system roles by the existing seed-time mechanism (no manual re-grant step). Every response includes a derived `isLowStock` — computed at read time, nothing extra stored.
- **`POST /v1/maintenance-jobs/:id/parts-used`** logs a part used against an open job: decrements the part's stock, snapshots its unit cost at the moment of use (so a later catalog price change doesn't rewrite what a past job cost), and records a Timeline event on both the job and the part. Rejects a quantity exceeding stock (`INSUFFICIENT_STOCK`) rather than allowing negative stock, and rejects logging against an already-closed job. Gated on `parts:create` — the same capability as creating an inventory transaction, not a new Maintenance permission.
- FleetHQ's Maintenance page gained a third "Parts" tab (catalog table with a low-stock warning icon, add/edit/archive) and a "Log parts" action on the Jobs tab; already-logged usage shows as a compact summary line under a job's title.
- **Deliberately not built**: supplier integration, reorder automation, multi-location stock, and rolling tracked-parts-usage cost automatically into the existing manual `partsCost` figure on close (the two are independent paths today — see `Workshop_Overview.md`'s implementation notes for the double-counting caveat this creates if a company uses both for the same job).

4 new e2e tests (catalog CRUD/archive/stock-adjustment, usage logging with stock decrement and cost snapshot, insufficient-stock and closed-job rejection, tenant isolation, permission gating). Live-tested end-to-end in a real Playwright-driven browser session: created a part with a low-stock threshold, logged parts used against a real maintenance job, and confirmed the stock decrement, low-stock warning icon, and the job's parts-used summary all appeared correctly.

## 2026-07-22 — Reporting depth: maintenance cost trend + fleet uptime (`apps/api` + `apps/fleethq`)

`17-Roadmap/Product_Roadmap.md`'s v1.x "reporting depth (cost trend analysis, uptime reporting)" line, extending the existing Reports page rather than starting a new one. Also incidentally fixed two stale lines in `07-FleetHQ/FleetHQ_Overview.md`'s implementation notes that still called Reports and the Universal Forms builder unbuilt, though both shipped earlier in this project.

- **`MaintenanceJob` gained optional `partsCost`/`laborCost`**, captured on the existing `POST /v1/maintenance-jobs/:id/close` (no new endpoint, no new permission) — giving real numbers behind `06-Workshop/Workshop_Overview.md`'s own "technician closes a job, logs parts used and labor time" line, though as a single total per job, not an itemized parts breakdown (still a distinct future "parts inventory" slice).
- **`GET /v1/reports/operations` now also returns `cost` and `uptime`**: `cost` is total maintenance spend closed within the window, an average per job, and a zero-filled per-day trend series. `uptime` is a fleet-wide uptime % plus a worst-first per-asset downtime breakdown, computed from time spent with an open **CRITICAL** maintenance fault — the same severity this codebase already treats as work-blocking elsewhere (Dispatch's assign warning, Operational Recommendations' scoring), not just any logged issue. Both are pure computation over existing rows (nothing new stored beyond the two cost fields), gated on the existing `reports:view`.
- FleetHQ's Reports page gained two new stat tiles (fleet uptime %, total maintenance cost), a dependency-free cost-trend bar chart (plain divs — this app has no charting library anywhere, so one wasn't added for this), and an "assets with downtime" table. The CSV export includes all of it. The Close Maintenance Job dialog gained optional parts/labor cost fields.

3 new e2e tests (cost totals/trend/average, 100%-uptime baseline with no faults, and downtime/uptime% for an asset with a critical fault — backdated via a direct Prisma update in the test, since the API has no way to time-travel a job's `createdAt` into the reporting window). Live-tested end-to-end in a real Playwright-driven browser session: closed a maintenance job with parts/labor cost and confirmed it appeared correctly in the Reports page's cost stats, trend chart, and CSV export.

## 2026-07-22 — Operational recommendations (`apps/api` + `apps/fleethq`)

`09-AI/Fleet_Intelligence_Overview.md`'s "operational recommendations" line — the last of Fleet Intelligence's five named scope items to get a first slice, and, like every other slice in this doc, built as a deterministic ranking with no AI/ML model.

- **`GET /v1/operational-recommendations/assets-for-job`** (gated `dispatch:view`) ranks active assets for a job assignment, starting from the same Fleet Health score and subtracting a penalty if the asset is already assigned to a different currently-open job (`?excludeJobId=` exempts a job's own already-assigned asset from penalizing itself, for the edit-assignment case). **`GET /v1/operational-recommendations/maintenance-priority`** (gated `maintenance:view`) ranks currently-open maintenance jobs by severity, then age (capped at 30 days), then whether the asset is currently tied to an open job. Both are read-only over existing data (nothing new stored) and return a `reasons: string[]` for each entry so the score is explainable, not a black box. No new permissions — both reuse the existing view permission for the data they're aggregating.
- FleetHQ's Dispatch "Assign" dialog reorders the asset picker by this ranking and marks the top available asset "Suggested — best available match for this job"; the existing critical-fault warning is unchanged and can appear alongside a suggestion on a different asset. The Maintenance page's Jobs tab gained a "Priority" column and now sorts open jobs by that score, highest first.
- **Suggestions only** — nothing here assigns a job, changes a job's status, or blocks picking any other asset; a human reads the ranking and decides, per this doc's own "recommends; a permitted human confirms" requirement.
- **Deliberately not built**: scheduling/ETA-aware ranking (accounting for how long an asset's current job will keep it busy) and any cross-depot weighting — a reasonable future increment, not attempted here.

4 new e2e tests (clean-vs-critical-fault asset ranking, busy-asset penalty with the `excludeJobId` exemption, maintenance priority ordering by severity/age/in-use, permission gating + tenant isolation). Live-tested end-to-end in a real Playwright-driven browser session: seeded one clean and one critically-faulted asset plus an open job, and confirmed the Assign dialog correctly reordered and flagged both, and the Maintenance page correctly sorted a critical fault above several normal ones.

## 2026-07-22 — AI Voice (`apps/driveros`)

`09-AI/AI_Voice.md`'s v1 command set, built entirely client-side with zero backend/LLM dependency — the deterministic core Core Principle 7 requires before any real NLP layer could sit on top of it, and the last of Fleet Intelligence's three named v1 capabilities to get a first slice.

- **Speech-to-text and speech synthesis are the browser's own native Web Speech API** (no API key, no server call) — push-to-talk (`continuous: false`), not a wake phrase, per the doc's privacy edge case against continuous listening.
- **All five documented commands work**, each routing into a flow that already had a full manual/touch path: "log damage"/"log [fault type]" (generalized to any "log"/"report" prefix, pre-filling — never auto-submitting — the Fault Report title), "call dispatch" (the existing company support phone via the same `tel:` link Help already ships), "next stop," "open checklist," and "read messages" (genuinely voice-only — speaks the latest office message aloud, then opens Messages).
- **Intent resolution is keyword matching, not an LLM call** — an unmatched transcript never guesses; it shows exactly what was heard and lists real commands to try. Rendered globally from `ProtectedRoute`, available on every DriverOS screen, not just Today.
- **Deliberately not built**: fuzzy/natural-phrasing understanding beyond the fixed keyword list (named as future work by the doc itself) and a server-driven, company-editable command list (the array lives in the app bundle, in one file, not yet configurable by a company admin).
- **Honest limitation**: this sandbox has no microphone/audio hardware, so real speech recognition accuracy can't be verified here — that's Chrome's own speech engine, not FleetOS's code. What *is* verified live, in a real browser: the complete pipeline from trigger press through to the correct navigation/action for all five commands plus the misrecognition fail-safe, by substituting a scripted fake `SpeechRecognition` at the Web API boundary — the same "inject at the external-dependency boundary" principle this codebase's e2e tests already use for third-party services.

Also surfaced (and worked around) a sandbox-only artifact: assigning `location.href` to a `tel:` URL in this headless environment leaves the tab in a pending-navigation state that blocks further scripted interaction, since there's no phone app to hand off to — not an app bug, and not reachable on a real device.

## 2026-07-22 — Predictive maintenance signals (`apps/api` + `apps/fleethq`)

`09-AI/Fleet_Intelligence_Overview.md`'s predictive maintenance line, built as a deterministic pattern detector with no AI/ML model involved — the working non-AI core Core Principle 7 ("AI enhances, never blocks") requires before any AI enhancement could sit on top of it. Also resolves `01-Product/Fleet_Graph.md`'s own named multi-hop example query, flagged unbuilt in that doc's implementation notes.

- **`GET /v1/predictive-maintenance/signals`** (gated `maintenance:view`) detects two patterns over existing Maintenance fault history and Fleet Graph `PAIRED_WITH` relationships, nothing new stored: `RECURRING_FAULT` (2+ same-title faults on one asset within 180 days) and `SHARED_ATTACHED_UNIT_PATTERN` (2+ assets that have shared an attached unit each developed a matching-title fault after that specific pairing began — a fault predating the pairing doesn't count).
- **OBD/CAN is explicitly not a data source** — that hardware integration doesn't exist, and this codebase never fakes a data source that isn't real. Fault matching is exact-title, not fuzzy/NLP — a simple, deterministic, testable rule.
- FleetHQ gets a "Signals" tab on the Maintenance page (mirroring Compliance's "Fatigue" tab), listing every current signal with a badge count. Recommendations only — nothing here creates a job, reassigns anything, or blocks dispatch.

3 new e2e tests, including one specifically exercising the pre-pairing-fault exclusion boundary (unhitch, re-hitch, and confirm only the post-re-pairing fault counts). Live-tested end-to-end in a real Playwright-driven browser session: a truck with two identical faults correctly showed a recurring-fault signal, and two trucks that shared a trailer with matching post-pairing faults correctly showed a shared-attached-unit-pattern signal.

## 2026-07-22 — Chain of Responsibility evidence pack (`apps/api` + `apps/fleethq`)

`08-Compliance/Australian_Compliance.md`'s CoR line — deferred at the Compliance milestone for a named reason ("better built once more of the underlying Timeline data exists to evidence"), now unblocked since Dispatch decisions, Smart Checklists, Maintenance, and Fatigue/Hours have all since shipped real Timeline data to assemble.

- **`GET /v1/compliance/cor-evidence/:jobId`** (gated `compliance:view`) assembles, for one Job, a read-only evidence pack: scheduling decisions (the Job's own Timeline events), the assigned operator's fitness-for-duty signal (fatigue breach/override events during the job's active window), and the assigned asset's condition (checklist submissions, any maintenance fault open at some point during the window, and every compliance document's validity **as of that window**, not "now" — so a since-expired document doesn't retroactively taint a job that ran while it was still valid). Nothing new is stored; it's assembled entirely from existing tables.
- **Deliberately out of scope**: "loading" (mass/dimension) obligations — per the doc's own note deferring that to when heavier Asset Classes exist — and any export/PDF generation; this is a live view, not yet a downloadable artifact.
- FleetHQ gets a `CorEvidencePanel` drawer (mirroring the Timeline/Relationships drawer shape) opened via a "CoR Evidence" row action on Dispatch, with a top-level flagged/clean banner. Works for jobs in any status, since CoR evidence is exactly the kind of thing pulled up after the fact.

5 new e2e tests (full pack assembly with flags, a clean job with no flags, a fatigue override surfacing correctly, an unassigned job degrading gracefully, permission gating + tenant isolation + 404 handling). Live-tested end-to-end in a real Playwright-driven browser session: a job with a failed checklist (auto-raising a maintenance fault) and an expired compliance document correctly showed all three as flagged concerns in the evidence panel.

## 2026-07-22 — Fatigue/Hours tracking (`apps/api` + `apps/fleethq` + `apps/driveros`)

`08-Compliance/Australian_Compliance.md`'s fatigue/rest-break line — deferred at the Compliance milestone for a named, now-resolved reason: no operator work/rest-hours clock existed until DriverOS's Shift start/end shipped. It has, so this builds the rule engine on top of it.

- **`FatigueService`** is jurisdiction-blind by construction (`08-Compliance/Jurisdiction_Model.md`): it resolves a company's `jurisdiction` to a `FatigueRuleSet` via a registry and never touches an AU-specific number itself. **AU Standard Hours (solo driver, v1 simplification)**: max 12h work/24h, min 7h continuous rest/24h, max 72h work/7 days, each `ok`/`approaching_limit`/`breach`. BFM/AFM schemes, two-up crewing, and minute-level break cadence are deliberately not modeled — see the doc's Implementation notes.
- A breach is written as a Timeline event on the Operator the moment a shift ends and pushes them over a limit. A dispatcher can still knowingly assign a flagged operator (`POST /v1/jobs/:id/assign` + `acknowledgeFatigueRisk: true`) — blocked with `FATIGUE_RISK_UNACKNOWLEDGED` (409) otherwise — but the override itself is logged as a distinct `fatigue_risk_overridden` Timeline event, never indistinguishable from a compliant assignment.
- FleetHQ: `AssignJobDialog` shows the risk and requires an explicit "assign anyway" checkbox before Save enables; Compliance gets a new "Fatigue" tab listing every at-risk operator. DriverOS: a `GET /v1/fatigue/me` (no permission gate) status card on Today, with no offline cache fallback since a stale reading would be actively misleading.
- **Found and fixed along the way**: none this time — full test suite (186 tests, 43 suites) stayed green throughout.

12 new e2e tests (24h/7-day rule checks, approaching-limit boundaries, fragmented-rest detection, shift-end breach event, assign-time block + override, permission gating, tenant isolation). Live-tested end-to-end in real Playwright-driven browser sessions across all three apps: a historical 13h shift correctly showed as "in breach" on the Compliance dashboard, blocked an unacknowledged assignment in Dispatch, succeeded once acknowledged (with the override event recorded), and rendered the same breach as a warning card on the operator's own DriverOS Today page.

## 2026-07-22 — Universal Forms: v1 across all three apps (`apps/api` + `apps/fleethq` + `apps/driveros`)

The third unstarted v1 launch-roadmap item, following Universal Search and Fleet Graph.

- **`FormTemplate`/`FormSubmission`** follow the exact versioned-template + immutable-snapshot pattern Smart Checklists established: a template's `version` bumps only when its `fields` actually change, and every submission carries its own `templateVersion` + full `templateSnapshot`. `targetContext` (`DRIVER`/`OFFICE`/`BOTH`) controls which app offers a template. Seven field types (`text`, `number`, `single_select`, `multi_select`, `date`, `asset_ref`, `operator_ref`), each server-validated; single-level conditional show/hide (one field's visibility gated on one earlier field's answer). Submitting writes Timeline events on the submission and every referenced asset/operator. Five new granular permissions (`forms:view/create/edit/archive/submit`).
- **Deliberately not built**: `photo`/`signature`/`GPS location capture` field types (each a materially larger feature than a same-shape field-type addition) and real branching/decision-tree conditional logic (only single-level show/hide exists) — both flagged in `01-Product/Universal_Forms.md`'s Implementation notes rather than faked.
- **FleetHQ**: a `FormBuilderDialog` (add/remove/reorder-via-buttons, matching the Dispatch/Checklists precedent for "drag-and-drop" specs) and a `FormsPage` with Templates/Submissions tabs.
- **DriverOS**: a `FormsPage` + `FormRunner`, reachable standalone from Today or from a job via the existing `?assetId=&assetName=` convention. Submits through the generic offline outbox with a client-generated id, idempotently replayed like a checklist or fault report. `asset_ref`/`operator_ref` have no search-and-select picker (no general asset/operator directory exists on DriverOS yet) — they resolve automatically instead: `operator_ref` to the operator filling the form in, `asset_ref` to the job asset the form was opened from.
- **Bug found and fixed**: FleetHQ's shared `FormLabel` component requires `FormField`/`FormItem` context. Both the new Forms builder and the already-shipped `ChecklistTemplateFormDialog` used it as a bare section heading outside that context, crashing the dialog on open — a real, previously-undetected regression in the shipped Checklists builder, only caught by live-testing the new Forms builder in an actual browser. Fixed both.

12 new e2e tests (template CRUD/versioning, submission validation and idempotent replay, conditional visibility, permission gating, tenant isolation). Live-tested end-to-end in real Playwright-driven browser sessions against both apps: built a form with conditional logic in FleetHQ; submitted a form exercising all seven field types from DriverOS (standalone and via job-context asset resolution) and confirmed every answer round-tripped correctly via the API.

## 2026-07-22 — Fleet Graph: relationship read side + PAIRED_WITH hitch/unhitch (`apps/api` + `apps/fleethq`)

The second unstarted v1 launch-roadmap item, following Universal Search. `graph_relationships` has been written to since the Dispatch milestone (an `OPERATED` relationship on every job assignment) but never read back, and the doc's second documented workflow (`AttachedUnit -[PAIRED_WITH]-> Asset`) was never built at all.

- **`GET /v1/graph/relationships?entityType=&entityId=`** — the first endpoint over `graph_relationships`. Answers `01-Product/Fleet_Graph.md`'s own first acceptance-criterion query directly: "which operators have operated this asset" and its inverse, for either direction of a relationship, resolving the other side's display name and splitting current from past.
- **`POST /v1/attached-units/:id/hitch`/`unhitch`** completes the doc's second workflow. Hitching to a new asset closes the unit's previous open pairing (one asset at a time per attached unit); `AttachedUnitsService.findAll`/`findOne` now resolve each unit's current pairing in one batched query.
- New `fleet_graph:view` permission (distinct from `assets:view`/`operators:view`/`attached_units:view` — being able to see a record doesn't mean being able to see its relationship history). Hitch/unhitch reuse `attached_units:edit` rather than a new permission, since pairing is a state change on the attached unit's own record.
- FleetHQ gets a `GraphPanel` drawer (mirrors the existing Timeline drawer) opened via a "Relationships" button on Assets, Operators, and Attached Units; Attached Units also gets Hitch/Unhitch actions and a "Paired with" column.
- Deliberately NOT built: multi-hop traversal (the doc's fault-pattern and customer-impact example queries need joining relationship history against Maintenance/Dispatch data that no query language exists for yet) — flagged in the doc rather than attempted half-working.

6 new e2e tests (relationship visibility in both directions, reassignment closing the old relationship, hitch/unhitch/re-hitch, permission gating, tenant isolation). Live-tested end-to-end in a real Playwright-driven browser session: assigned a job, confirmed the OPERATED relationship from the asset's side, hitched and unhitched an attached unit, confirmed the list, drawer, and row actions all update correctly.

## 2026-07-22 — Universal Search: non-AI-fallback slice (`apps/api` + `apps/fleethq`)

The first genuinely unstarted v1 launch-roadmap item (`17-Roadmap/Product_Roadmap.md`) to get built, rather than another FOUNDER_NOTES rough edge — the existing `CommandPalette` was navigation-only (jump to a page), never real entity search.

- **`GET /v1/search?q=`** — literal, case-insensitive substring matching across Assets, Operators, Attached Units, Customers, Depots, Jobs, Maintenance jobs, and Compliance documents (by number). This is `01-Product/Universal_Search.md`'s own explicitly-allowed non-AI fallback: natural-language intent resolution and the Command Bar's direct-action mode are Fleet Intelligence capabilities deferred the same way AI Voice is, not built here.
- Permission-filtered per entity type (not per route — searching itself isn't gated, but a type is only queried/returned if the caller holds its `:view` permission), ranked exact-match > starts-with > contains.
- FleetHQ's `CommandPalette` (Ctrl+K/Cmd+K) now merges live entity results with the existing nav-page results, grouped by type with icons; clicking a result navigates to that entity's list page (no per-record detail routes exist anywhere in FleetHQ yet, so "get there instantly" means "get to the right module" in this slice).
- Real fuzzy typo-tolerance ("Vovlo" → Volvo) is deferred — would need Postgres's `pg_trgm` extension or an external index, a new dependency not justified for this slice. DriverOS's own Universal Search roadmap bullet is also deferred — its screens are already narrow/task-focused with nothing to search into yet.

6 new e2e tests (permission filtering, tenant isolation, ranking, no-special-permission-required). Live-tested end-to-end in a real Playwright-driven browser session against the booted dev server and API: created an Asset and an Operator, searched for each by partial name, confirmed grouped results and correct navigation on click.

## 2026-07-22 — Platform hardening: notification abstraction, real push, bulk import gaps, admin-lockout guard, mute preferences, Privacy spec + erasure, onboarding/decommissioning doc, Support/Help pathway (`apps/api` + `apps/driveros` + `apps/fleethq`)

A sixth batch closing out every remaining item from a full gap audit against `FOUNDER_NOTES.md`, except what was explicitly ruled out of scope (billing/subscription management, and anything from the documented-but-never-started v1 product surface — Universal Search, Fleet Graph UI, Universal Forms, AI/Fleet Intelligence, Documents/Knowledge Base, OBD/CAN). Backend suite grew 121 → **150 across 39 suites**; all three apps build/typecheck/lint clean; live-smoke-tested against a booted server and real Postgres (company support contact set/read → operator created → data exported → archived → personal data erased, its still-referenced records intact throughout).

- **Notification channel abstraction.** Real email/SMS sending needs a real provider account and API key that doesn't exist yet — rather than fake it or block on a business decision, built the provider-ready seam only: `NotificationChannel` interface (`sendEmail`/`sendSms`) behind a NestJS DI token, with `LoggingNotificationChannel` (structured logs, no live delivery) as the only implementation until a real provider is chosen. The email digest now sends through this interface instead of directly marking rows.
- **Real Web Push notifications.** Unlike email/SMS, Web Push needs no third-party account — a locally-generated VAPID keypair plus the browser's native `PushManager`. New `PushSubscription` model (User-scoped, no RLS, same reasoning as `users`), `GET /v1/push/vapid-public-key` + `POST /v1/push/subscribe`/`unsubscribe`, service workers in both `apps/fleethq` and `apps/driveros`. In-app notifications now fire an actual push alongside the DB row (fire-and-forget, deliberately not awaited inside the caller's own transaction). Settings toggles in both apps.
- **Bulk import for AttachedUnits + Compliance documents.** Extends the existing generic `importRows()` helper to the two resources the previous batch's import job missed.
- **Admin-lockout guard.** Nothing stopped a user removing their own last administrative permission, changing their own role away from one that could manage roles/users, or stripping `roles:edit`/`users:edit` from the only role that granted them — each left a company with no way to recover short of direct DB access. `AdminLockoutGuardService` rejects any of the three when no active membership would still hold both permissions afterward. Tightened mid-batch (see below) to only fire when the company genuinely *has* an admin right now, so it never collaterally blocks unrelated actions in a company that simply never concentrated those two permissions onto one role.
- **Per-notification-type mute preferences.** Extends the existing digest-only toggle: a user can now silence a specific notification type (job assignments, failed deliveries, checklist-raised faults, messages) entirely — a muted type is never recorded, so it can't drive an unread badge, a push, or a digest line. `GET /v1/notifications/types` + `mutedTypes` on the existing preferences endpoint.
- **Privacy & Data Protection spec + operator data export/erasure.** `FOUNDER_NOTES.md`'s "Privacy Act obligations, distinct from asset compliance" gap had no spec and no tooling. New `14-Security/Privacy_Data_Protection.md` scopes FleetOS's role (the customer company is the data controller; FleetOS gives their admins the tools) and the erase-vs-retain boundary. `GET /v1/operators/:id/data-export` bundles everything held about an operator; `POST /v1/operators/:id/erase-personal-data` redacts name/contact/licence-number fields and tombstones scanned files, gated on the operator already being archived — each its own granular permission (`privacy:export`, `privacy:erase`).
- **Onboarding/decommissioning workflow doc.** New `01-Product/Onboarding_Decommissioning.md` writes down the concrete Asset/Operator lifecycle using only existing capabilities. Writing the Operator decommissioning step down surfaced a real bug: archiving an Operator's profile didn't revoke a linked DriverOS login. Fixed — `OperatorsService.archive()` now deactivates any linked `CompanyMembership` in the same action.
- **Support/Help pathway.** `FOUNDER_NOTES.md`'s "what's the actual path to help" gap. New `01-Product/Support_Help_Pathway.md`, `Company.supportPhone`/`supportNotes` (readable by any authenticated user, no permission gate — same precedent as notification preferences), and a DriverOS `/help` screen offering the existing Messages thread as the primary path and a `tel:` link as the fallback that works with zero app connectivity.

Two real bugs found via live debugging rather than review, both fixed in the same commit that introduced them: a missing `UPDATE` grant on `push_subscriptions` (Prisma's `upsert()` needs it, `INSERT`/`SELECT` alone isn't enough) and the same gap on `attachments` (needed once erasure had to tombstone one in place). 29 new tests across 6 new spec files, each with tenant-isolation/permission coverage. `npm run build` (`tsc -b`) run for every job, not just `tsc --noEmit` — this batch's own README fix (job 1) removed two other stale "known gap" claims that turned out to already be built, a documentation-drift problem worth naming explicitly rather than re-introducing.

## 2026-07-22 — Onboarding + hardening: getting-started checklist, bulk import for Depots/Customers, permission-drift fix, offline shifts, notification preferences (`apps/api` + `apps/driveros` + `apps/fleethq`)

A fifth batch, deliberately mixed: three jobs chip away at `FOUNDER_NOTES.md`'s top-flagged risk ("if onboarding is painful, nothing else matters"), the other three fix real gaps this build had been quietly accumulating across the previous four batches. Backend suite grew 121 → **128 across 34 suites**; all three apps build/typecheck/lint clean; live-smoke-tested each job against a booted server and real Postgres.

- **Guided setup checklist.** A dismissible Dashboard widget (FleetHQ) tracking the concrete first steps a brand-new company needs — first asset, first operator, invite a teammate, first job, first compliance document. Reuses the exact permission-gated list endpoints the rest of the Dashboard already queries (shared React Query keys), so it adds zero new backend surface and zero extra requests.
- **Bulk import for Depots + Customers.** Extends the existing Assets/Operators CSV-import wizard to two more resources, reusing `DepotsService`/`CustomersService.create()` per row exactly like the other two do. Refactored the by-then four near-identical `ImportsService` methods into one generic `importRows()` helper rather than a fourth copy-paste.
- **Seed-script/system-role permission drift, fixed for real.** Every permission this build has added (`depots:*`, `shifts:*`, `timeline:view`, ...) required someone to remember to manually re-grant it to existing companies' Administrator role via the Roles UI — `provisionCompany()` only computes "every permission" once, at company-creation time. `reconcileSystemRolePermissions()` (framework-agnostic, same pattern as `provision-company.ts`) grants any catalog permission missing from a company's Administrator role, and any `:view` permission missing from its Read Only role, leaving custom/cloned roles untouched. Wired into `seed.ts` (every local dev run) and exposed standalone via `npm run permissions:sync` for a deploy-time step.
- **DriverOS offline support for shift start/end.** `apps/driveros/src/api/shifts.ts` did a plain online-only POST with no outbox fallback — a driver clocking in/out with no signal would silently lose the action, a direct violation of CLAUDE.md's "offline-first, always." Now queues to the same outbox `completeStop` uses and drains on reconnect; `getCurrentShift` gained the same network-first-then-cache fallback Today's job list already has.
- **Notification preferences (digest-only).** `FOUNDER_NOTES.md`'s Notifications gap calls for "user-configurable preferences... so a workshop manager doesn't get 40 pings." New `User.digestOnlyNotifications`: a digest-only user's notifications still record and still feed the email digest, they just stop driving the live in-app unread badge. `GET/PATCH /v1/notifications/preferences`, no permission required (every user manages their own) — wires the placeholder Notifications card FleetHQ's Settings page has had since the Notifications milestone.

7 new tests across 3 new spec files (bulk import for Depots/Customers, the permission reconciliation, notification preferences), each with tenant-isolation/permission coverage where relevant. The getting-started checklist and offline-shifts jobs are frontend-only and needed no new backend tests. `npm run build` (`tsc -b`, not just `tsc --noEmit`) was run for every job this batch, per the lesson the previous batch's live smoke test taught the hard way.

## 2026-07-22 — Courier vertical, 10 more: depots, delivery windows, failure reasons, reattempt, shifts, timeline viewer, operator compliance docs, dispatch date filter, email digest (`apps/api` + `apps/driveros` + `apps/fleethq`)

A fourth batch, the largest yet — ten jobs rounding out the delivery/courier vertical (`00-Company/Commercial_Priority.md`). Backend suite grew 99 → **121 across 31 suites**; `apps/api`, `apps/fleethq`, and `apps/driveros` all build/typecheck/lint clean; each job committed as its own backend+frontend checkpoint (one extra fix-up commit for a `tsc -b`-only Button-variant error and a digest-preview response leak, both caught during this final verification pass, not by the per-job checks). Live smoke-tested end-to-end against a booted server and real Postgres: depot created → job assigned a pickup depot → windowed stop added → delivery failed with a structured reason → reattempted into a fresh job → the original job's full history read back off `/v1/timeline` → a shift started/ended → an operator licence document logged with a file scan → its Glovebox read back → the dispatch view filter partitioned jobs correctly → an email digest previewed and sent.

One combined migration (`20260722014512_add_depots_shifts_stop_extensions_compliance_operator`) carries all new/changed tables for this batch, verified schema-safe against the full pre-existing suite before any new tests were added.

- **Depots (pickup/branch locations).** New `Depot` model (archivedAt reference-record, mirrors Customer) — the fleet's own pickup/branch locations, distinct from Customer (who the fleet delivers *to*). `Job` gains an optional `pickupDepotId`, settable at creation or via the existing assign endpoint alongside asset/operator. New `depots:view/create/edit/archive`. FleetHQ gets a Depots page and a pickup-depot picker on job creation/assignment.
- **Delivery time windows + on-time tracking.** `JobStop` gains optional `windowStart`/`windowEnd`. `GET /v1/reports/operations` gains `deliveries.onTime` (assessed/onTime/late/rate — only stops that actually had a window count, everything else is honestly "not assessable" rather than silently on-time). FleetHQ's stop-add form and Reports page show it; DriverOS shows a due-by time and an overdue flag on Today and the delivery-completion screen.
- **Structured failure reasons.** `CompleteStopDto` gains an optional `failureReason` enum (nobody home, access denied, business closed, address issue, refused, other) alongside the existing free-text note — additive, so no historical FAILED stop needs to retroactively classify one. Rejected if paired with a DELIVERED outcome. Reports gains a `failureReasons` breakdown (a "not recorded" bucket, not silently folded into "other"). DriverOS gets a reason-chip picker on a failed delivery; FleetHQ shows it on the stop row.
- **Reattempt a failed delivery.** `POST /v1/jobs/:id/stops/:stopId/reattempt` — a failed stop's redelivery attempt lands on a fresh (or a given existing) job as a new PENDING stop tagged `reattemptOfStopId`, carrying over the active asset/operator; the original stop and job are never mutated. (A completed run's last stop failing already auto-completes that job, so the reattempt has to go elsewhere — never onto the same, now-terminal, job.) FleetHQ gets a Reattempt action on failed stops.
- **Shift start/end + day summary.** New `OperatorShift` model; `POST /v1/shifts/start`/`end` (only the caller's own linked Operator can clock in/out), `GET /v1/shifts/current`, `GET /v1/shifts/summary` (per-operator shifts + total minutes for a date, clipping ongoing shifts at "now"). New `shifts:view`/`shifts:manage`. DriverOS gets a Start/End shift control on Today; FleetHQ's Reports page gets a Shift day summary section.
- **Entity Timeline viewer.** First read endpoint over `timeline_events` (`GET /v1/timeline?entityType=&entityId=`) — every mutation across the platform has been writing here since the foundation milestone, but nothing had read it back until now. New `timeline:view`. Kept as a separate `TimelineQueryService` rather than adding `PrismaService` to the existing framework-agnostic, write-only `TimelineService` (shared with the non-NestJS seed script). FleetHQ gets a Timeline drawer wired onto Customers, Depots, and Dispatch jobs.
- **Compliance operator docs + Glovebox file uploads** (folds two of the ten into one model change). `ComplianceDocument.assetId` is now optional and a new `operatorId` was added — never both, never neither, enforced by the server and a DB `CHECK` constraint — so a Licence or Medical Certificate can be logged against an Operator the same way Registration/Insurance/Roadworthy log against an Asset. Either kind can carry a scanned/photo `Attachment` (`fileAttachmentId`, reusing the existing inline-upload path). `GET /v1/operators/:id/glovebox` mirrors the existing asset Glovebox. FleetHQ's Compliance page gets an asset/operator target toggle and a file upload/view control; DriverOS gets a "My Documents" Glovebox for the operator's own docs.
- **Dispatch date filter (Today/Upcoming/History).** `GET /v1/jobs?view=today|upcoming|history` — a 3-way partition every job falls into exactly one of: `history` (terminal, any date), `upcoming` (active, scheduled after today), `today` (active and either unscheduled or due today-or-earlier, so nothing active is ever hidden by the filter). FleetHQ's Dispatch page gets a tab bar over it, defaulting to Today.
- **Email digest notification channel.** No real SMTP provider is wired up yet, so "sending" a digest computes what each recipient's unread, not-yet-emailed notifications would say and marks them `emailedAt` — a repeat run never double-sends, the same "simulate the infra now, swap it in later" precedent `Attachment` set by storing bytes in Postgres. New `notifications_digest:send` gates `GET/POST /v1/notifications/digest/preview|send`; FleetHQ's Administration page gets a Notifications tab to preview and trigger it.

New permissions this batch (`depots:*`, `shifts:*`, `timeline:view`, `notifications_digest:send`) mean the recurring seed-script permission drift applies — pre-existing Administrator roles need them granted via the Roles UI; e2e tests grant them explicitly. 22 new tests across 7 new spec files (plus one extension to the existing reports spec), each with its own route-permission and tenant-isolation coverage.

## 2026-07-22 — Courier vertical, another 5: customers, bulk stop import, POD signature, repeat-a-run, stop reorder (`apps/api` + `apps/driveros` + `apps/fleethq`)

A second batch of five jobs advancing the delivery/courier vertical (`00-Company/Commercial_Priority.md`), following the same next-5 pattern as the previous batch. Backend suite grew 96 → **99 across 24 suites** (net of a mid-batch refactor); all three apps build/typecheck/lint clean; each job committed as its own checkpoint and the full set smoke-tested together live against Postgres (customer created → manifest imported, matching/creating customers → stops reordered → a stop delivered with a signature → the run duplicated clean).

- **Customers & saved addresses.** New `Customer` model (archivedAt reference-record, mirrors AttachedUnit) — a fleet-internal address book. `JobStop` gains an optional `customerId`: when a stop references a customer, label/address/contactName default from it but any explicit field still overrides. New `customers:view/create/edit/archive`. FleetHQ gets a Customers page and a saved-customer picker on the stop-add form. Internal directory only — no customer login or portal (`CLAUDE.md` scope).
- **Bulk stop import (manifest CSV).** `POST /v1/jobs/:id/stops/import`, gated on the existing `dispatch:edit` (bulk input is a method, not a new capability). Same dry-run/commit shape as the existing Assets/Operators import; a `customerName` column matches an existing active Customer or creates one on commit, and a matched customer's saved address always wins over a different one in the manifest row. Refactored the three tiny per-row-result helpers out of `ImportsService` into `common/imports/import-helpers.ts` so Dispatch's stop import can reuse them without a backwards module dependency (existing import behavior unchanged, verified by its existing tests). FleetHQ's delivery-run dialog gets an "Import CSV" button reusing the existing generic wizard.
- **Proof of Delivery signature capture.** `CompleteStopDto` gains `signatureBase64`/`signatureContentType`/`signatureFilename`; stored as a second inline Attachment via the same path photos already use (`JobStop.signatureAttachmentId`). DriverOS gets a canvas `SignaturePad` (Pointer Events, uniform across finger/stylus/mouse) on the stop-completion screen; FleetHQ shows the signature next to the photo.
- **Repeat a run (duplicate job).** `POST /v1/jobs/:id/duplicate`, gated on the existing `dispatch:create`. Clones title/asset/operator/stops (including each stop's customerId) into a fresh job with clean PENDING stops — no completion data carries over, since this is a new run, not a record of the old one. The asset/operator are only carried over if each is still active; an archived one silently drops rather than assigning the duplicate to something gone. FleetHQ's Dispatch page gets a one-click "Repeat" row action, available regardless of the source job's status (the main use case is repeating a *completed* run).
- **Stop reorder + DriverOS next-stop focus.** `POST /v1/jobs/:id/stops/reorder`, gated on the existing `dispatch:edit`. Only PENDING stops are reorderable — a completed/failed stop's sequence is historical fact and is never disturbed, even when interleaved between pending ones being reordered. FleetHQ gets move-up/move-down controls per pending stop (arrow buttons rather than full drag-and-drop — no dnd library was already a dependency, and this is the smaller v0 slice). DriverOS's Today screen now surfaces a prominent "Next stop" card above the full stop list, so a driver doesn't have to scan a flat list to find what's next.

15 new e2e specs across the five jobs (customers CRUD + stop defaulting, stop-import dry-run/commit/customer-matching, signature capture, duplicate + archived-resource handling, reorder + historical-slot preservation), plus route-permission and tenant-isolation coverage for each.

## 2026-07-22 — Courier vertical, the next 5: storage, Proof of Delivery + multi-stop runs, notifications, reporting (`apps/api` + `apps/driveros` + `apps/fleethq`)

Executes `17-Roadmap/Courier_Vertical_Next5.md` — the five jobs that take the delivery/courier vertical to a demoable, pilot-ready standard, per `00-Company/Commercial_Priority.md` (delivery fleets first, finish before deploying). Backend suite grew 73 → **84 across 20 suites**; all three apps build/typecheck/lint clean.

- **File & photo storage (enabler).** `Attachment` model — bytes in Postgres, base64-over-JSON upload so it replays through the DriverOS offline outbox; `POST /v1/attachments` + a streaming `GET /v1/attachments/:id`; `attachments:view/upload`; express JSON limit raised to 15 mb; reusable `createInTx` for inline proof photos. Object-storage swap is a deploy-time change behind the same API. (4 specs.)
- **Multi-stop delivery runs + Proof of Delivery** (folds two of the five into one model). A Job carries ordered `JobStop`s; the operator completes each on DriverOS with an outcome (delivered / attempted-failed), recipient, note, and a camera photo — offline-first, idempotent on replay — and the job rolls up to COMPLETED when every stop is terminal. New `dispatch:deliver` permission; proof photo stored inline in the same transaction. FleetHQ Dispatch shows stop progress and a delivery-run dialog with each stop's POD (photo fetched with auth as a blob). Internal capture only, not customer-facing sharing (`CLAUDE.md` scope). (3 specs.)
- **Notifications** (cross-cutting, `FOUNDER_NOTES` named gap). Per-user `Notification` model with in-transaction `notifyUser`/`notifyPermission` helpers other services call so a notification commits atomically with its trigger: failed delivery → Dispatch watchers; new message → the other side; auto-raised checklist fault → the workshop; new assignment → the operator. Personal endpoints carry no permission (every user sees only their own, avoiding seed drift). Live bell + unread badge on FleetHQ's topbar and a DriverOS Alerts screen. In-app only for now. (2 specs.)
- **Operational reporting.** `GET /v1/reports/operations` — a read-model over a date range: deliveries (delivered/failed + rate), checklist activity, open workshop jobs, per-operator breakdown. New `reports:view`; FleetHQ Reports page (was Coming Soon) with date range, stat tiles, per-operator table, and CSV export. (2 specs.)

New permissions this batch (`attachments:*`, `dispatch:deliver`, `reports:view`) mean the recurring seed-script permission drift applies — pre-existing Administrator roles need them granted via the Roles UI; e2e tests grant explicitly. Committed as four checkpoints on the branch.

## 2026-07-22 — Founder directive: delivery fleets first, finish before deploying (governance)

Recorded a standing commercial directive that now governs prioritisation: **finish the product for the delivery/courier vertical before deploying it**, trial it at a company the founder works for (pending their agreement), sell to delivery fleets, and only then expand to other fleet types/verticals/projects. Deployment is explicitly deferred — a deliberate founder trade-off against the engineering instinct to deploy a thin slice first. Captured in `00-Company/Commercial_Priority.md`, and enforced via a new "Commercial priority" section at the top of `CLAUDE.md` (read before any work). No code change — this is a decision record. See `Commercial_Priority.md` for the full framing and the day-to-day "does this make the courier product sellable?" test.

## 2026-07-16 — DriverOS Messages v0 + Smart Checklists "today" status (`apps/api` + `apps/driveros` + `apps/fleethq`)

Two follow-on slices after the Smart Checklists milestone (same day): the DriverOS Messages screen, and a small office-facing extension of Smart Checklists.

**DriverOS Messages v0** — the eleventh product slice, the "messaging" line item of DriverOS's v1 scope. A single operator ↔ office thread per Operator, replacing the "what's next" phone call/SMS. New `Message` model (append-only — the app role gets only `SELECT, INSERT`, the same structural immutability `timeline_events`/`checklist_submissions` use; deliberately NOT mirrored into `timeline_events` since a thread is already its own append-only log). `GET/POST /v1/messages` with new `messages:view`/`messages:send` permissions. **Identity is server-enforced, never trusted from the client**: an operator (resolved from the JWT's linked Operator) can only ever read/write their own thread — a client-supplied operatorId is ignored for operators — while an office user addresses any operator by id. DriverOS gets an offline-first Messages screen (network-first-then-cache read, outbox-queued send with an optimistic "Sending…" bubble reconciled on the next fresh fetch, reached from a Messages link on Today); FleetHQ gets a Messages module (operator list + thread + composer). **Scoped down, stated up front**: no attachments/photos, read receipts, group/broadcast threads, or push notifications — a plain two-party text thread. Same seed-script permission drift as every new-permission slice (pre-existing Administrator roles need `messages:*` granted; e2e tests grant it explicitly). 5 new e2e specs (`test/messages.e2e-spec.ts`).

**Smart Checklists — today's pre-start status** — completes `01-Product/Smart_Checklists.md` Workflow #4 ("Office sees completed/incomplete checklist status for every asset"), which the milestone itself left unbuilt. New `GET /v1/checklist-status/today` read-model (pure computation over existing submissions, no stored state — the Fleet Health Score pattern): for each active asset, whether its pre-start checklist was completed today and whether it recorded failures, plus a done/not-done/with-failures summary. "Today" is the server calendar day; since scheduling/assignment is deferred, the modeled expectation is simply "every active asset does a daily pre-start." Surfaced as a new "Today" tab (the default) on FleetHQ's Checklists page with a summary tile row and a per-asset status table. Gated on the existing `checklists:view` — no new permission. 1 new e2e spec.

Full verification: backend **73/73 passing across 16 suites** (up from 67/15). Typecheck + lint clean on `apps/api`; both frontends build/typecheck/lint clean. Verified live against real local Postgres on the booted server: an office user sent a message into an operator's thread (recorded as `OFFICE`, read back in order) and `checklist-status/today` reported a freshly-created asset as `not_done`.

## 2026-07-16 — Smart Checklists milestone: versioned templates + offline operator submissions (`apps/api` + `apps/driveros` + `apps/fleethq`)

Tenth product milestone, and the one the previous two DriverOS milestones were explicitly maneuvering around. DriverOS v0 and Digital Glovebox were each chosen *because* they were smaller and let us defer this — Smart Checklists is the first DriverOS workflow with operator-**editable** state (a checklist is filled in progressively, not fired off in one shot like a fault report), which is exactly the thing the offline-sync engine v0 said it had punted on. Full scope rationale in `17-Roadmap/Milestone_10_Smart_Checklists.md`.

**The forcing function, resolved narrowly and honestly**: the sync engine v0 was create-only with "no conflict resolution … nothing to conflict yet." This slice introduces editable state as a new local-only `checklistDrafts` IndexedDB store (every answer persisted the instant it's made, reloaded on return — the spec's "never lose captured answers mid-flow" edge case), while keeping the *submission* a single immutable create over the existing create-only outbox. So there is still exactly one writer per checklist and no multi-writer merge machinery was invented. The real conflict surface here is **template drift**, resolved by **version snapshotting**: a submission records the exact `items` the operator saw (client-sent, possibly against an older cached version) plus the template `version`, so a later office-side edit never rewrites a completed or in-progress checklist. Editing a template bumps `version`; renaming doesn't. Submissions carry a client-generated `id` so an outbox replay after a lost response is idempotent — never a second checklist or a second auto-created workshop job. Genuine multi-device concurrent editing of the same checklist remains deferred, and is stated as such.

**Scope, stated up front**: data-driven templates (`items` JSON: `pass_fail`/`pass_fail_na`, plus two boolean follow-ups `requireNoteOnFail`/`createsFaultOnFail`) — NOT the full Universal Forms drag-and-drop builder, no conditional question trees, no photo/location/measurement capture, no scheduling/assignment. New spec section added to `01-Product/Smart_Checklists.md` recording what this slice implements.

**Backend**: `ChecklistTemplate` (versioned, `archivedAt` reference-record lifecycle like ComplianceDocument, optional `appliesToAssetClass` by key) and `ChecklistSubmission` (immutable — the app role is granted only `SELECT, INSERT`, never UPDATE/DELETE, the same structural immutability `timeline_events` uses). `GET /v1/checklist-templates?assetId=` resolves the applicable templates for an asset by its class, so the same API serves DriverOS and FleetHQ (API-first). A failed item flagged `createsFaultOnFail` creates a workshop `MaintenanceJob` **inline in the same transaction** (not via `MaintenanceService`, which opens its own — so checklist and faults commit atomically), satisfying the spec's headline "one operator interaction produces a workshop job, no further data entry" acceptance criterion. Completed checklists write Timeline events on the asset *and* the operator. New permission category `checklists:view/create/edit/archive/submit`; operator identity on submit is resolved server-side from the JWT's linked Operator, never trusted from the client. **Same seed-script permission drift as every prior new-permission milestone** — pre-existing Administrator roles need `checklists:*` granted via the Roles UI; e2e tests grant it explicitly per tenant.

**Frontend — DriverOS**: a new offline-first Pre-Start Checklist screen reached from Today via the same `?assetId=&assetName=` pattern Fault Reporting/Glovebox use; network-first-then-cache for the applicable templates so a synced operator can complete a checklist in a dead zone.

**Frontend — FleetHQ**: a new Checklists module (nav + page) with a Templates tab (structured item editor) and a Completed tab (operator submissions with a read-only detail view rendered from each submission's own snapshot). Also fixed a latent pre-existing FleetHQ typecheck error a cold `tsc -b` surfaced (`OperatorsListPage`'s link-user `onSubmit` returned `Promise<Operator>` where `Promise<void>` was expected) so the build is green.

Full verification: backend `test/checklists.e2e-spec.ts` (8 specs: template versioning, applicable-template-by-class, the fail→workshop-job criterion, snapshot immutability across a later edit, idempotent replay, the fail→note-required branch + answer validation, tenant isolation, route permissions) — **67/67 passing across 15 suites**, up from 59/14. Typecheck + lint clean on `apps/api`; both frontends build/typecheck/lint clean. Verified live against real local Postgres on the booted server: signed up a company, created a template with a fault-raising tyre item, created an asset, submitted a checklist failing that item, and confirmed the workshop MaintenanceJob (`Checklist fault: Tyres undamaged`) was auto-created and the submission recorded its own `templateSnapshot`/`templateVersion`.

## 2026-07-15 — Digital Glovebox milestone: DriverOS view-only asset documents + emergency contact (`apps/api` + `apps/driveros` + `apps/fleethq`)

Ninth product milestone, DriverOS's second real slice after v0 (Login/Today/Fault Reporting). Chosen over Smart Checklists specifically because it's the smaller, purely-additive next step: it reuses data the Compliance milestone already built end-to-end, requires no new offline-write path, and therefore doesn't yet force designing real conflict resolution the way Smart Checklists' operator-editable state would.

**Scope, stated up front**: view-only, reusing the already-built `ComplianceDocument` model — not the full `01-Product/Digital_Glovebox.md` spec's file-upload document store (PDF/image, versioning, per-attached-unit support, upload-triggered Timeline events). Registration/insurance/roadworthy status is served straight from `ComplianceService`, and a single new free-text `Asset.emergencyContact` column covers the emergency-contact requirement.

**Backend**: `Asset.emergencyContact` (nullable string). `GET /v1/assets/:id/glovebox` (new, on the existing Assets module) calls `ComplianceService.findAll()` directly rather than re-deriving expiry-status logic, and returns `{ asset: { id, name, emergencyContact }, documents }`. `AssetsModule` now imports `ComplianceModule` (a fourth intentional cross-module backend dependency). Gated on the pre-existing `assets:view` alone — no new permission category, and deliberately no secondary `compliance:view` check (unlike Fleet Health Score's fleet-wide rollup), since this is scoped to one asset the caller already has standing to see, the same precedent Dispatch set for a Job's nested Asset name.

**Frontend — FleetHQ**: the Asset form gained an "Emergency contact (optional)" field, wired through to create/update.

**Frontend — DriverOS**: a new "Digital Glovebox" screen, reached from Today via the current job's asset (same `?assetId=&assetName=` pattern Fault Reporting uses). Uses the same network-first-then-IndexedDB-cache pattern as Today's job list.

Full verification: backend test suite 59/59 passing across 14 suites (up from 54/13); new `test/digital-glovebox.e2e-spec.ts` covers the endpoint's data shape, tenant scoping, permission gating, and 404 handling. Both frontends typecheck clean. Manually verified end-to-end in live browser previews against real local Postgres: added an emergency contact and two compliance documents (one valid, one expiring soon) to an asset via direct API calls, confirmed FleetHQ's Asset edit form round-trips the emergency contact correctly, and confirmed DriverOS's new Digital Glovebox screen renders both documents with correct expiry-status colors and the emergency contact. The offline-cache fallback was verified by genuinely forcing the network call to fail (patching `XMLHttpRequest`/`fetch`, not just toggling `navigator.onLine`) and confirming the exact same data was served from IndexedDB with `fromCache: true`.

## 2026-07-15 — DriverOS v0 milestone: login, Today, Fault Reporting, offline-sync engine v0 (`apps/api` + `apps/fleethq` + `apps/driveros`)

Eighth product milestone, and the first to build any part of DriverOS (`04-DriverOS/`) — previously 0% built and gated behind designing an offline-sync engine, per `CLAUDE.md`'s "offline-first, always" non-negotiable. Scoped to the smallest real slice that's actually testable end-to-end as a second client: **Login**, **Today**, and **Fault/Damage Reporting**. Not built: Smart Checklists, Digital Glovebox, Messages, AI Voice, photo capture, or any real conflict resolution.

**Consequential fork, resolved by asking rather than assuming**: an `Operator` record wasn't login-capable — only `User` accounts were. Per `CLAUDE.md`'s "ask, don't assume" authority order, this was put to the founder directly (three options) rather than picked silently mid-build. Decision: link `Operator` to a real `User` account, reusing FleetHQ's exact login/JWT/permission system rather than building a parallel Operator-auth mechanism.

**Backend**: `Operator.userId` (nullable, unique, FK to `User.id`, `ON DELETE SET NULL`). `POST /v1/operators/:id/link-user` (gated `users:create`) delegates to the same `UsersService.create()` path `POST /v1/users` uses, reusing the Operator's existing `fullName`, then records a `login_linked` Timeline event. `GET /v1/auth/me` now also resolves and returns the caller's linked `operator: { id, fullName } | null`. `GET /v1/jobs` gained `operatorId`/`status` query filters so DriverOS can ask for "my currently-assigned job" directly. No new permission category — `dispatch:view`/`maintenance:create` (both pre-existing) are all a "Driver" role needs.

**Frontend — FleetHQ**: Operators tab gained a "DriverOS" column (Linked/No login) and a "Link login" row action (gated `users:create`, hidden once linked).

**Frontend — new `apps/driveros`**: a second Vite + React + TypeScript SPA (same stack as FleetHQ, to minimize context-switching and because a responsive web app is the only practical choice given a BYO-Android-tablet strategy and no native mobile build/test tooling available). Single dark-only theme, `min-h-14` touch targets, `user-select: none` + `touch-action: manipulation`. **Offline-sync engine v0**: IndexedDB (`idb` package) `outbox` (queued mutations) + `cache` (last-known-good reads) stores; queued mutations replay sequentially on reconnect (stop-on-first-failure); Today's job list and the logged-in identity both fall back to cache on a network failure rather than logging the operator out or blanking the screen. Deliberately no conflict resolution yet — this slice's only writes are creates and its only read isn't operator-edited, so nothing can conflict; real conflict resolution is deferred until a workflow (e.g. Smart Checklists) introduces edits to shared state.

Full verification: backend test suite 54/54 passing across 13 suites (up from 49/12); `apps/driveros` typechecks clean. Manually verified end-to-end in live browser previews against real local Postgres: created an Operator, linked it to a new DriverOS login via the FleetHQ UI, assigned it a Dispatch job, logged into DriverOS as that Operator and confirmed Today correctly showed the assigned job and asset; submitted a fault report while online and confirmed a real `MaintenanceJob` row appeared immediately in FleetHQ's own Maintenance page; simulated going offline, submitted a second fault report, confirmed it queued client-side (StatusBar: "Offline — showing last synced data · 1 report waiting to sync") and was *not* yet in Postgres; simulated reconnect and confirmed the queued report synced automatically with no user-initiated action, appearing in FleetHQ's Maintenance queue moments later.

## 2026-07-14 — Fleet Health Score milestone: per-asset scoring (`apps/api` + `apps/fleethq`)

Seventh product milestone after Import, chosen over starting DriverOS (still gated behind designing its offline-sync engine) and over Notifications/Reporting (no spec or data model exists for either yet). Rolls up the two most recently-shipped modules — Workshop and Compliance — into the Dashboard's oldest-standing placeholder widget.

**Scope, stated up front**: a deliberately scoped-down slice of `01-Product/Fleet_Health_Score.md`'s full requirement list — a per-asset score derived from open Maintenance jobs (severity-weighted) and Compliance document expiry only. Not built: tyre condition, OBD-derived driving behavior (neither has a data source), predictive scoring, or configurable scoring weights (fixed constants for now).

**Backend**: `GET /v1/fleet-health` (new `fleet-health` module, no new Prisma entity — a pure read-model computation, nothing stored). Score starts at 100, minus 35 per open Critical maintenance job, 10 per open Normal one, minus 30 for any expired compliance document or 10 for expiring-within-30-days (worst case only). Clamped to [0, 100]. Every score returns its full factor breakdown (status + human-readable detail) — there is no "bare number" response shape. Missing-data transparency: zero open maintenance jobs scores `ok`; zero compliance documents scores `not_assessed` (not a misleading 100) — the two are deliberately distinguishable.

**New cross-permission pattern**: gated on `assets:view` (a Health Score is fundamentally an Asset property), but each factor is independently checked against `maintenance:view`/`compliance:view` via a new `PermissionCheckerService` — extracted from `PermissionGuard`'s own lookup query for reuse *inside* application logic — so a caller without one of those permissions gets `not_permitted` for that factor rather than learning "this asset has an open critical fault" secondhand. First reusable in-service permission check in the codebase.

**Frontend**: the Dashboard's Fleet Health Score placeholder widget is now real (average score + at-risk badge), linking through to `/fleet-health` — every asset sorted worst-first with its full breakdown. No sidebar nav entry, following the same precedent as Fleet Graph (a Dashboard-anchored drill-down, not a top-level module).

Full verification: lint/typecheck/build clean on both `apps/api` and `apps/fleethq`; new `test/fleet-health.e2e-spec.ts` (scoring math for clean/at-risk assets, fleet rollup averaging and worst-first sorting, permission-gated factor visibility, tenant isolation, route-level permission enforcement) — 49/49 tests passing across 12 suites, up from 43/11. Manually verified end-to-end in a live browser against real local Postgres: confirmed a clean 3-asset fleet scored 100 average with "All clear"; logged an open Critical maintenance job against one asset and confirmed both the Dashboard widget and the `/fleet-health` page recomputed live to a 65 score for that asset, an 88 fleet average, and "1 at risk" — sorted to the top of the list.

## 2026-07-14 — Import milestone: bulk CSV import for Assets/Operators (`apps/api` + `apps/fleethq`)

Sixth product milestone after Compliance, chosen over starting DriverOS because `FOUNDER_NOTES.md` names data migration/onboarding-from-paper as "the single biggest risk to your '10 minutes to first value' mission... one of the very first Phase 2 additions" — a risk that had already been named and deliberately deferred across the Workshop and Compliance build-order decisions. DriverOS remains correctly gated behind designing its offline-sync engine first, a separate undertaking.

**New spec written, not just scoped down**: unlike every previous milestone, no Playbook doc covered onboarding/import yet. New file `01-Product/Onboarding_Import.md` (following the standard doc structure) now exists as the source of truth for this capability, per `CLAUDE.md`'s documentation discipline.

**Scope, stated up front**: CSV upload → client-side column mapping → server-side dry-run validation preview → commit. Not built: Customer/Depot import (those entities aren't modeled), duplicate detection, or AI-assisted column mapping.

**Backend**: `POST /v1/imports/assets` and `POST /v1/imports/operators`, both accepting `{ rows, dryRun }`. Reuses `AssetsService.create()`/`OperatorsService.create()` directly per row — same DTO validation, same Timeline "created" event a manual entry gets — rather than a parallel bulk-specific path. `dryRun: true` validates every row and writes nothing; committing re-validates and creates only the valid rows independently, so one bad row never blocks the rows around it. Batch capped at 500 rows per request. **No new permission category** — gated on the pre-existing `assets:create`/`operators:create`, since import is a bulk input method for a capability that already exists, not a new one. `AssetsModule`/`OperatorsModule` now export their services so `ImportsModule` can import and reuse them.

**Frontend**: a generic `ImportWizardDialog` (upload → map → preview → commit steps) reused for both Assets and Operators via a small field-config prop, with an "Import CSV" action added next to "New asset"/"New operator." Uses `papaparse` for correct CSV parsing (quoted fields, escaping) — added as a new frontend dependency rather than hand-rolling a parser for a real onboarding feature.

**No seed-script permission drift this time** — the first milestone to add a whole new capability without adding a new permission, so there was nothing for an existing Administrator role to be missing. Documented in `14-Security/Permissions_Model.md` as confirming the drift is specifically a consequence of *new permission categories*, not a general property of shipping new FleetHQ features.

Full verification: lint/typecheck/build clean on both `apps/api` and `apps/fleethq`; new `test/imports.e2e-spec.ts` (dryRun validation, partial-success commit, tenant isolation, permission enforcement, batch-size limit) — 43/43 tests passing across 11 suites, up from 37/10. Manually verified end-to-end in a live browser against real local Postgres: uploaded a 4-row Assets CSV (one blank name, one unimplemented Asset Class) and confirmed the preview correctly flagged both while leaving 2 valid, then committed and confirmed exactly those 2 were created with the real per-row rejection reasons shown (including the actual `ASSET_CLASS_NOT_IMPLEMENTED` service-layer error, not just DTO-level validation); repeated for a 2-row Operators CSV with one invalid email, same result.

## 2026-07-14 — Compliance milestone: document expiry tracking (`apps/api` + `apps/fleethq`)

Fifth product milestone after Workshop, chosen over the alternatives (starting DriverOS, tackling onboarding-from-paper) because it's the only remaining `ComingSoonPage` module in FleetHQ with a full existing spec ready to build against, and — unlike DriverOS — it doesn't require designing an offline-sync engine first to avoid violating `CLAUDE.md`'s non-negotiable "offline-first, always" principle.

**Scope, stated up front**: a deliberately scoped-down slice of `08-Compliance/Australian_Compliance.md`'s full v1 requirement list — per-asset registration/insurance/roadworthy document logging with a derived expiry status. Not built: NHVR requirements, Chain of Responsibility evidencing, or fatigue/hours tracking (no operator work/rest-hours data source exists until DriverOS ships), and no cross-referencing with Maintenance's open-fault data (unlike Dispatch's assign dialog).

**Backend**: `ComplianceDocument` entity (`ComplianceDocumentType`: Registration/Insurance/Roadworthy; `jurisdiction` defaulting `"AU"`; `archivedAt` — the Asset/Operator/AttachedUnit reference-record pattern, not Job/MaintenanceJob's terminal-status pattern, since a document has no natural terminal lifecycle). Expiry status (`valid`/`expiring_soon`/`expired`, 30-day window) is computed at read time from `expiresAt`, never stored. `POST/GET /v1/compliance-documents`, `GET/PATCH /v1/compliance-documents/:id`, `POST /v1/compliance-documents/:id/archive`, with an `assetId` list filter. New permissions: `compliance:view/create/edit/archive`.

**Frontend**: a real Compliance page (document list sorted soonest-expiring-first, log/edit dialog, archive confirmation) — the closest thing to this milestone's "compliance dashboard" without the fatigue/CoR data this slice doesn't have.

**Same seed-script permission drift observed a third time, exactly as documented twice before**: both companies' pre-existing Administrator roles needed `compliance:*` granted (Acme via the live Roles UI, Southern Star Logistics via a direct role update) before the Compliance nav item appeared — now a confirmed, permanent operational fact of this system rather than something worth re-flagging as new each milestone.

Full verification: lint/typecheck/build clean on both `apps/api` and `apps/fleethq`; new `test/compliance.e2e-spec.ts` (create→edit→archive lifecycle, expiry-status computation across all three buckets, `assetId` filtering, tenant isolation, permission enforcement) — 37/37 tests passing across 10 suites, up from 33/9. Manually verified end-to-end in a live browser against real local Postgres: logged a registration document with a near-term expiry and confirmed it computed as "Expiring Soon," edited its expiry further out and confirmed it recomputed to "Valid," created an expired one and confirmed "Expired," then archived a document and confirmed it dropped out of the active list while still visible via `includeArchived=true`.

## 2026-07-14 — Workshop milestone: Maintenance jobs + multi-company invite (`apps/api` + `apps/fleethq`)

Fourth product milestone after Dispatch, chosen over the alternatives (Compliance dashboard, starting DriverOS) because it's next in the Playbook's own v1 sequence, it turns two existing Dashboard placeholder widgets (Fleet Health Score, Upcoming Maintenance) into candidates for real data, and it closes a gap in Dispatch's own spec: an acceptance criterion ("an asset with an open critical maintenance fault is visibly flagged before it's assigned new work") that couldn't be met until Workshop existed.

**Scope, stated up front**: a deliberately scoped-down slice of `06-Workshop/Workshop_Overview.md`'s full v1 requirement list — manual job logging, a linear status lifecycle, an optional approval record, and a severity flag Dispatch reads. Not built: Smart Checklist/OBD/CAN auto-creation of jobs (neither data source exists yet), service-due scheduling (needs odometer/last-service fields on Asset that don't exist yet), duplicate-report merging, or parts inventory.

**Backend**: `MaintenanceJob` entity (`MaintenanceSeverity`: Normal/Critical, `MaintenanceJobStatus`: Open/In Progress/Parts Pending/Complete — no `archivedAt`, same "terminal status is the no-hard-delete mechanism" pattern as Dispatch's `Job`). `POST/GET /v1/maintenance-jobs`, `GET/PATCH /v1/maintenance-jobs/:id`, `POST /v1/maintenance-jobs/:id/approve`, `POST /v1/maintenance-jobs/:id/close`. New permissions: `maintenance:view/create/edit/approve/close`, mapping onto `14-Security/Permissions_Model.md`'s own Maintenance example list.

**Bundled**: the multi-company invite-existing-user flow (`POST /v1/users/link`) — the other half of Multi-Company Support that the Administration API milestone left unbuilt. Looks up the target user by username via the same narrow, SELECT-only `fleetos_auth` role login's pre-context lookup already uses (necessary since, by definition, no shared CompanyMembership exists yet between the two companies). A unique constraint on `(userId, companyId)` means linking a previously-deactivated membership reactivates it rather than erroring.

**Dispatch integration made real, not just documented**: the Dispatch "Assign" dialog's asset picker now visibly flags (warning icon + inline text) any asset with an open, Critical-severity maintenance job — a read-model-only integration, no coupling between the Assets/Dispatch/Maintenance modules' write paths.

**Frontend**: a real Maintenance page (job list, log-job dialog, inline status changes, approve/close actions); a "Link existing user" action alongside "Invite user" in the Administration Users tab.

**Same seed-script permission drift observed again, exactly as predicted last milestone**: the pre-existing Administrator role needed the five new Maintenance permissions granted through the Roles UI before the nav item and Fleet-adjacent UI appeared — confirms this is a recurring, expected operational step, not a one-off.

Full verification: lint/typecheck/build clean on both `apps/api` and `apps/fleethq`; new `test/maintenance.e2e-spec.ts` (create→edit→approve→close lifecycle, terminal-state rejection, tenant isolation, permission enforcement) and new invite-existing-user tests added to `test/users.e2e-spec.ts` (grant access, reject unknown username, reject already-active membership, reactivate a deactivated one) — 33/33 tests passing across 9 suites, up from 26/8. Manually verified end-to-end in a live browser against real local Postgres: logged a Critical maintenance job, confirmed it flagged the asset in the Dispatch assign dialog, approved and closed it with resolution notes; linked one existing login (`test-viewer`, previously scoped to a single company) to a second company with a different role, and confirmed the login flow now offers a company choice between both.

## 2026-07-14 — Dispatch milestone: Jobs + AttachedUnit API (`apps/api` + `apps/fleethq`)

Third product milestone after FleetHQ v1, chosen over the alternatives (AttachedUnit API alone, or starting DriverOS) because it's the smallest real workflow that both unblocks Fleet Graph (nothing had ever written to `graph_relationships` before this) and gives FleetHQ a genuinely operational page rather than another admin screen.

**Scope, stated up front**: a deliberately scoped-down slice of `05-Dispatch/Dispatch_Overview.md`'s full v1 requirement list — job creation, assignment to an Asset/Operator, and status. Not built: live map/GPS, OBD-derived status, route optimization, operator chat, customer-job messaging, digital paperwork status, or the AI-predictions layer — all genuinely require data sources that don't exist yet (live telemetry, a DriverOS client, a Customer entity).

**Backend**: `Job` entity (`JobStatus`: Unassigned/Assigned/Completed/Cancelled — no `archivedAt`, since a Job's terminal states already satisfy "no hard deletes"). `POST/GET /v1/jobs`, `GET/PATCH /v1/jobs/:id`, `POST /v1/jobs/:id/assign` (independently set/clear Asset and/or Operator via `null`), `POST /v1/jobs/:id/complete`, `POST /v1/jobs/:id/cancel`. New permissions: `dispatch:view/create/edit/assign/cancel`, mapping onto `14-Security/Permissions_Model.md`'s own Dispatch example list.

**Bundled**: the `AttachedUnit` API (`GET/POST/PATCH /v1/attached-units`, `.../archive`) — CRUD-only, mirrors Asset/Operator exactly. New permissions: `attached_units:view/create/edit/archive`.

**Fleet Graph's first real write path**: assigning a Job to both an Asset and an Operator opens a timed `OPERATED` GraphRelationship (`01-Product/Fleet_Graph.md`); reassigning, completing, or cancelling the job closes it. `GraphRelationship` gained no `jobId` column — open/close is derived by matching the Operator+Asset pair itself, a deliberate scope limit.

**Frontend**: Fleet page is now tabbed (Assets / Attached Units), mirroring the Administration page's tab pattern. Dispatch flips from "Coming Soon" to a real page: job list, create/assign dialogs (Select-based, with an explicit "— Unassigned —" option), complete/cancel with confirmation dialogs, a `JobStatusBadge`.

**One real, expected gap surfaced during verification, not a bug**: the existing "Administrator" role (created before this milestone) didn't retroactively gain the new permissions — platform-wide `Permission` catalog entries don't propagate to already-created company roles automatically (documented risk: "seed-script permission drift"). Granted them through the live Roles UI as part of verification, which is the correct, by-design behavior — a company's roles never silently expand.

**One test-convention fix**: the permission-key format test (`permission-catalog.spec.ts`) only allowed single-word resources; widened to snake_case (`attached_units`) since that's now a real, legitimate resource name.

Full verification: lint/typecheck/build clean on both `apps/api` and `apps/fleethq`; new `test/dispatch.e2e-spec.ts` (AttachedUnit CRUD + tenant isolation, Job assign→complete lifecycle, GraphRelationship open/close, terminal-job rejection, permission enforcement) — 26/26 tests passing across 8 suites, up from 21/7. Manually verified end-to-end in a live browser against real local Postgres: created an AttachedUnit, created a Job, assigned it to a real Asset and Operator, confirmed the "Assigned" badge and resolved names, marked it complete, confirmed the terminal "Completed" state with all actions correctly disabled.

## 2026-07-14 — FleetHQ v1 foundation (`apps/fleethq`)

First FleetHQ code milestone: a working, production-quality web client for the API surface built in the two prior milestones — not a prototype. Stack: Vite, React 19, TypeScript, TanStack Query, React Router v7, Tailwind CSS v4 (CSS-first `@theme`), Radix UI primitives, React Hook Form + Zod, class-variance-authority. Chosen for a calm, fast, Linear/Stripe-Dashboard-style feel per the design brief, and because every piece is a client of the same versioned API any third-party integration would use (`12-API/API_Architecture.md`'s API-first rule) — no FleetHQ-only backend shortcuts.

**Built**: full auth flow (login, multi-company selection, session persistence via a new `GET /v1/auth/me` endpoint), app shell (sidebar navigation, topbar, light/dark/system theme), a widget-grid Dashboard (Fleet/Operators/Users counts, live System Health via `/health/ready`, placeholder widgets for Fleet Health Score/Upcoming Maintenance/Recent Activity/Fleet Graph so future modules don't require a redesign), Fleet (Assets) and Operators CRUD pages, Administration (Company/Users/Roles as permission-gated tabs), Profile, Settings, a Command Palette (Cmd/Ctrl+K, navigation-only today — the working foundation for `01-Product/Universal_Search.md`), and a toast notification shell. Unbuilt modules (Maintenance, Dispatch, Compliance, Documents, Knowledge Base, Reports, AI) appear in navigation as "Coming Soon" rather than being omitted, per the brief.

**One small, justified backend addition**: `GET /v1/auth/me` (`apps/api`) — returns the caller's real, freshly-resolved permission set so the UI can gate navigation/actions proactively instead of reactively catching 403s. Verified against real Postgres (21/21 tests passing, up from 20).

**Permission-awareness verified as real, not just filtered-in-the-sidebar**: created a zero-permission test role and user via the live Administration UI, logged in as that user, and confirmed nav items, dashboard widgets, and a direct URL visit to `/administration` are all correctly hidden or redirected.

**One real bug found by exercising the UI, not by review**: optional form fields (Operator email/phone) were submitted as empty strings rather than omitted, which the backend's `@IsEmail()` validator correctly rejects (`@IsOptional()` only skips validation for an absent field, not an empty one). Fixed in `OperatorFormDialog.tsx` by normalizing blank optional fields to `undefined` before submission.

**Scope not yet built**: Universal Forms builder, deeper multi-company management beyond the login-time switcher, full entity search (Command Palette is navigation-only until a search endpoint exists), and a dedicated accessibility audit against `13-UI-UX/Design_System.md`'s standard-web-accessibility acceptance bar.

Full verification: `npm run lint`/`tsc -b`/`vite build` clean; manual login → Dashboard → Fleet → Operators → Administration walkthrough against real local Postgres and a live `apps/api` instance, including create/edit/archive flows and the permission-aware low-privilege user test above. Nothing committed to git per this milestone's build instructions — left as a reviewable diff.

## 2026-07-13 — Enterprise readiness review (`apps/api`)

Founder direction: engineer FleetOS as enterprise-grade from day one — a national logistics customer with thousands of vehicles should never require a rewrite — without making a five-vehicle courier company pay for infrastructure it doesn't need yet. Reviewed the ~19 stated enterprise requirements against the actual codebase (an Explore pass confirming current state, a Plan pass designing the resolution) rather than assuming, then implemented via an approved plan. New reference doc: `02-Architecture/Scaling_And_Enterprise_Readiness.md` — the full tiered model (build now / design-the-seam-now-build-on-trigger / defer entirely) and the reasoning behind every placement.

**Headline finding**: most of the hard problems were already solved correctly before this review — real Postgres RLS for tenant isolation (not app-layer filtering), a fully stateless/horizontally-scalable app tier, RBAC with company-defined custom roles, jurisdiction/Asset-Class abstractions that make international/multi-modal expansion additive, and an auth design (`AuthService.issueSessionToken()`) that already makes future SSO additive. None of that needed changing — reaffirmed in the new doc and cross-referenced from `System_Architecture.md`, `Data_Model.md`, `Permissions_Model.md`.

**Built now (Tier 0)**:
- `GET /health` (liveness) and `GET /health/ready` (readiness, checks Postgres) — version-neutral, outside `/v1/`.
- Structured JSON logging (`nestjs-pino`) replacing plain-text console output; `Authorization` headers redacted.
- A security/access audit trail distinct from `TimelineEvent` on purpose: login success/failure (with reason) and permission-denied rejections are now structured log events, not business-entity history.
- Graceful shutdown (`app.enableShutdownHooks()`) — a real gap, not hypothetical: without it a rolling deploy hard-kills in-flight requests.
- Connection pool sizing guidance documented for when a second app instance is deployed.
- `TimelineEvent` rows now get an explicit client-generated UUIDv7 (time-ordered) id instead of the schema default UUIDv4 — the platform's highest-write-volume, longest-retention table benefits from insert locality and partition-readiness now; no schema change needed, and deliberately not applied to any other table.

**Designed now, built later on a named trigger (Tier 1)** — documented in the new reference doc, not built: background jobs (`pg-boss`, triggered by the first real async workload), in-process domain events (triggered by the first real second consumer of a mutation — `TimelineEvent` writes stay synchronous regardless, that's correctness-critical), cursor pagination (triggered by a tenant table exceeding ~100k rows), `TimelineEvent` partitioning (triggered by row count or measured slowdown), PgBouncer/managed pooler (triggered by a second app instance), a Prometheus metrics endpoint (triggered by a real incident or SLA), a queryable security-audit table (triggered by a compliance need beyond log search), feature flags (triggered by a real rollout need), and service extraction (reaffirming `System_Architecture.md`'s existing OBD/CAN-telemetry-ingestion trigger rather than extracting anything now).

**Deferred entirely, no code today**: distributed tracing, microservice/container-orchestration decisions, automated partition rotation tooling, offline-sync engine build-out (no DriverOS client exists yet to build it against).

**One real dependency bug found by running the test suite, not by review**: the `uuid` npm package's current major version is ESM-only and breaks under Jest's CommonJS transform. Switched to the dedicated `uuidv7` package (zero dependencies, proper CommonJS export) — also simply a better-scoped choice for a one-function need.

Full verification: lint/typecheck/build clean; all 20 existing tests still pass against real local Postgres (confirming zero regression to the two prior milestones); manual curl walkthrough of health/readiness, a deliberately-triggered login failure and success, a deliberately-triggered permission denial, and a `TimelineEvent` row confirmed to have a UUIDv7-shaped id; a real `SIGTERM` confirmed to shut the process down cleanly.

## 2026-07-13 — Administration API milestone (`apps/api`)

Second code milestone, built on the foundation slice: self-service company signup, user management, and role management — the "10 minutes to first value" on-ramp (`00-Company/Mission.md`) that the foundation milestone's known-gaps list called out as missing.

**Company signup** — `POST /v1/companies` (public) creates a Company, its Administrator and Read Only role templates, and the first admin User atomically, then logs that user straight in — no separate login call needed. `GET`/`PATCH /v1/companies/me` for basic profile settings. The provisioning logic (`src/companies/provision-company.ts`) is shared between this endpoint and `prisma/seed.ts`'s local dev bootstrap, specifically so the two can't quietly drift apart the way "the seed script is the only way to create a company" made likely.

**User management** — `POST/GET /v1/users`, `PATCH /v1/users/:id/role`, `POST /v1/users/:id/deactivate`. Operates on CompanyMembership records (a User can belong to multiple companies — see `14-Security/Permissions_Model.md`), so "deactivate" archives the membership, not the underlying login identity. Closed the gap flagged in the foundation milestone: `users` now has real row-level security, scoped by "shares a CompanyMembership with the requesting company," with one narrow, explicitly-documented exception for login's pre-context username lookup (a new `fleetos_auth` database role — BYPASSRLS, but granted `SELECT` on `users` and nothing else at all).

**Role management** — `POST/GET/PATCH /v1/roles`, `POST /v1/roles/:id/clone`, `POST /v1/roles/:id/archive`. Archiving enforces `14-Security/Permissions_Model.md`'s edge case as a hard rule: a role with active members can't be archived until they're reassigned (`409 ROLE_IN_USE`, naming how many users are affected).

**Timeline coverage extended**: `TimelineEntityType` gained `USER`, `ROLE`, and `COMPANY` — administration actions get the same permanent history as fleet entities (`00-Company/Core_Principles.md` #3), not just Assets/Operators.

**Two more real RLS bugs found and fixed while verifying against real Postgres** (same lesson as last milestone — code review didn't catch either):
1. `INSERT ... RETURNING` (what Prisma's `.create()` always generates) re-checks SELECT visibility on the row being returned, not just the WITH CHECK governing the write. Creating a brand-new User failed with "new row violates row-level security policy" because the user has no CompanyMembership yet at the exact instant of insertion, and the users policy required one to exist for the row to be visible. Fixed by generating the id client-side and inserting via `createMany` (no RETURNING) instead of `.create()`.
2. Deactivating a user made them disappear entirely, including from the response confirming the deactivation — the users policy required an *active* membership, and archiving someone's only membership makes that condition false for the very row `.update()` was trying to read back. Fixed by allowing visibility via any membership, active or archived; whether to list deactivated users by default stays an application-layer choice.

Both are additive migrations (`20260713080000_admin_entities_and_users_rls`, `20260713081500_fix_users_rls_visible_when_archived`), consistent with the "don't rewrite already-applied migrations" approach from the previous milestone.

**Known, deliberately out-of-scope gaps**:
- No flow to grant an *existing* User (already has a login at another company) access to a second company — `POST /v1/users` always creates a brand-new User. The data model supports it; the invitation/discovery UX isn't specified anywhere, so it wasn't built speculatively.
- Re-running `npm run seed` against an already-seeded database won't retroactively add newly-introduced permissions to existing companies' Administrator roles (the idempotency check skips provisioning entirely once a company exists by that name). Not a problem for a fresh database; a real gap for anything resembling a production migration story later.
- No safeguard against a user removing their own last administrative permission, or archiving the only role capable of managing roles/users. Not specified anywhere; flagged as a rough edge rather than a built-but-unrequested feature.
- Full verification performed against real local Postgres 16 (all 6 migrations, fresh seed, automated suite of 20 tests across 7 suites, and a manual curl walkthrough of the entire signup → role → invite → role-in-use-block → deactivate → archive flow with Timeline events checked at each step).

## 2026-07-13 — First code: foundation milestone (`apps/api`)

Stack approved: NestJS + TypeScript (modular monolith), PostgreSQL with row-level security, native Kotlin DriverOS and React/TypeScript FleetHQ (neither built yet — this milestone is backend-only). Built the foundation slice per the FIRST MILESTONE scope: project scaffold, the core data model, and a working Asset + Operator registry with granular, server-enforced permission checks.

**Scaffold** — `apps/api`: NestJS/TypeScript, Prisma/PostgreSQL, ESLint/Prettier, Jest, `docker-compose.yml` for local Postgres, `.env.example`, `apps/api/README.md` for dev setup, `.github/workflows/api-ci.yml` (lint, typecheck, migrate against a real Postgres service container, build, test) — see `15-Testing/Testing_Strategy.md` and `16-Deployment/Deployment_Overview.md`.

**Data model** — `Company, User, Role, Permission, CompanyMembership, RolePermission, AssetClass, Asset, Operator, AttachedUnit, TimelineEvent, GraphRelationship` per `11-Database/Data_Model.md` and `02-Architecture/Asset_Class_Model.md`. Multi-tenancy is enforced with real Postgres row-level security (a dedicated low-privilege `fleetos_app` runtime role, policies keyed on a per-request session GUC), not just application-layer filtering — see `11-Database/Data_Model.md`'s new implementation notes and the migration file itself for the reasoning, including the deliberate `users`-table RLS gap.

**Auth & permissions** — Company-issued username/password login (`12-API/API_Architecture.md` scoped tokens; `CLAUDE.md`'s v1 login scope), with a two-step flow for Multi-Company Support (`14-Security/Permissions_Model.md`) when a user has more than one active company membership. Permissions are resolved fresh from the database on every request rather than cached in the JWT, so revocation is immediate. Fixed a real contradiction found while implementing this: `14-Security/Permissions_Model.md`'s example permission list included a "Delete" action alongside "Archive," which is impossible given `11-Database/Data_Model.md`'s "no hard deletes" constraint — removed it.

**Asset & Operator registries** — Full CRUD (create/list/get/update/archive) behind `/v1/assets` and `/v1/operators`, each action gated by its own permission, every mutation writing a `TimelineEvent` in the same database transaction (so a mutation and its history entry can't diverge). Timeline immutability is enforced structurally, not just by convention: the runtime DB role has no `UPDATE`/`DELETE` grant on `timeline_events` at all. Asset creation validates against `AssetClass.isImplemented`, so attempting to create a non-Land Asset fails clearly rather than silently accepting data the rest of the platform can't act on yet.

**Tests** — Per `15-Testing/Testing_Strategy.md`'s required coverage: API-layer integration tests proving cross-company data is unreachable by list or by direct id (`test/tenant-isolation.e2e-spec.ts`) and that unauthorized actions are rejected server-side with a consistent error shape regardless of resource (`test/permissions.e2e-spec.ts`), plus DB-free unit tests for the permission catalog and pagination helper.

**Known, deliberately out-of-scope gaps** (flagged per `CLAUDE.md`: "flag rather than quietly implementing a workaround," not silently built around):
- No Administration API (create company, manage users, edit roles) — a seed script (`apps/api/prisma/seed.ts`) is the only way to bootstrap local data. `07-FleetHQ/FleetHQ_Overview.md`'s Administration area is the natural next slice.
- `AttachedUnit` is modeled in the schema but has no API resource yet, even though `12-API/API_Architecture.md` says every entity should get one — the milestone brief scoped the API deliverable to Asset and Operator specifically.
- `GraphRelationship` is modeled but nothing writes to it — no Dispatch/Fleet Graph workflow exists yet to generate relationships from.
- Offline/sync, webhooks, and rate limiting (all named in `12-API/API_Architecture.md`) aren't built — there's no DriverOS client yet for offline sync to matter against.
- No self-service company signup — same gap as the Administration API above, just stated from the login side.

## 2026-07-13 — Foundation milestone verified end-to-end; two RLS bugs found and fixed

The build environment had no Docker, so the previous entry above shipped with the RLS migration and integration tests unverified against a real database — reviewed carefully, but not actually run. Installed PostgreSQL locally (Homebrew) to close that gap before trusting it. Running the real test suite against a real Postgres instance immediately surfaced two bugs that code review had missed — recorded here because they're not obvious and the next person touching `apps/api/prisma/migrations/` should know about them before adding a new RLS policy:

1. **The `companies` table's own RLS policy blocked login.** `company_memberships` was given a dual-condition policy (visible if it's the current tenant, *or* it belongs to the current user) specifically so a user could discover their own company memberships before a tenant context exists. `companies` needed the same escape hatch — a login response needs the company's *name*, and the join into `companies` was silently coming back empty under RLS, so every login failed with `NO_COMPANY_ACCESS` even though the membership row existed. Fixed in `20260713071500_companies_visible_to_members`.
2. **Postgres custom session settings don't reset to NULL the way "missing_ok" suggests.** `current_setting('app.x', true)` only returns true `NULL` if `app.x` was *never* referenced on that backend connection. Once any transaction sets it via `SET LOCAL`-style `set_config(..., true)` and that transaction ends, it reverts to an *empty string*, not NULL — and Prisma's connection pool reuses connections across unrelated transactions, so a connection previously used for a user-scoped lookup (login) would later throw `invalid input syntax for type uuid: ""` on a completely unrelated company-scoped request that happened to reuse the same pooled connection. Fixed in `20260713072000_fix_rls_stale_session_guc` by reading every session GUC through `NULLIF(current_setting(...), '')::uuid` instead of a bare cast, everywhere in the RLS policies — the same pattern needs to be used in any future policy that reads `app.current_company_id` or `app.current_user_id`.

Both fixes are additive migrations, not edits to the original migration files, so the sequence is an honest record of what actually happened. Full verification performed: `prisma migrate deploy` (all 4 migrations, including RLS) against real Postgres 16; `npm run seed`; manual curl smoke test (login, create Asset, create Operator, confirm a TimelineEvent was written, confirm a second company sees zero of the first company's Assets); and the full automated suite (`npm test`) — all 10 tests pass, including both required-coverage integration tests from `15-Testing/Testing_Strategy.md`.

## 2026-07-13 — Phase 1: Foundation established

- Created repository structure (19 numbered folders, root governance files).
- Established `CLAUDE.md` as the operating contract for AI coding agents in this repo.
- Locked in strategic decisions from founder input:
  - First customer: small courier companies; architecture must scale to any fleet size from day one.
  - Hardware strategy: BYO Android tablets, optional supplier agreement for convenience, no proprietary hardware dependency.
  - Login: company-issued username/password only for v1.
  - Dispatch: AI predictions treated as a distinct layer, not baked into core dispatch workflow.
  - Customer-facing tracking/portal explicitly deferred to future roadmap — v1 is fleet-internal only.
  - Compliance scope: Australia only at launch, architecture jurisdiction-abstracted for future expansion.
  - Business model: software-first; hardware only pursued if a distribution partnership is commercially sound.
- Wrote `Vision.md`, `Mission.md`, `Product_Philosophy.md`, `Core_Principles.md`, `Product_Overview.md`.

## Format going forward

Each entry should include the date, a short summary of what changed, and — for anything that reverses or contradicts a prior decision — why.

## 2026-07-13 — Phases 2 through 6 completed, Founder Notes added

- Phase 2 (Product): full specs for Universal Search & Command Bar, Fleet Graph, Digital Glovebox, Smart Checklists, Universal Forms, Timelines, Fleet Health Score, Fleet Intelligence overview, AI Voice, Modular Permissions & Custom Roles.
- Phase 3 (Architecture): System Architecture, Hardware strategy & Universal Vehicle Hub, OBD/CAN Integration, Data Model, API-First Architecture, Australian Compliance, Jurisdiction Model.
- Phase 4 (UI/UX): Design System, Dispatch, Workshop, FleetHQ, and DriverOS overviews.
- Phase 5 (Engineering): Testing Strategy, Deployment & CI/CD, FleetOS product roadmap.
- Phase 6 (Future): Future Vision, Customer Portal (deferred), Open Platform (deferred).
- Added `FOUNDER_NOTES.md`: honest gap analysis (missing: onboarding/migration, notifications system, privacy/data protection, billing, backup/DR, vehicle/driver onboarding workflows, support pathway) and de-scoping recommendations (cut/delay: multi-company support, full NHVR/CoR/fatigue engine, AI Voice, graph-native database, "Fleet DNA" — all moved out of v1 launch scope or retired as named concepts).

## 2026-07-13 — Terminology consistency fix (Vehicle/Driver/Trailer → Asset/Operator/Attached Unit)

- `02-Architecture/Asset_Class_Model.md` and `CLAUDE.md` mandated generic terminology repo-wide, but most spec files written before that decision (`11-Database/Data_Model.md`'s core entity list, `01-Product/*`, `02-Architecture/System_Architecture.md`, `03-Hardware/*`, `04-DriverOS/DriverOS_Overview.md`, `05-Dispatch/Dispatch_Overview.md`, `06-Workshop/Workshop_Overview.md`, `07-FleetHQ/FleetHQ_Overview.md`, `08-Compliance/*`, `09-AI/*`, `13-UI-UX/Design_System.md`, `14-Security/Permissions_Model.md`, `15-Testing/Testing_Strategy.md`, `17-Roadmap/Product_Roadmap.md`, `PRODUCT_ROADMAP.md`, `FOUNDER_NOTES.md`, `18-Future/Future_Vision.md`, `18-Future/Customer_Portal.md`, and the `00-Company/` constitution docs themselves) still used "Vehicle," "Driver," and "Trailer." This directly violated `02-Architecture/Asset_Class_Model.md`'s own acceptance criteria ("No table, API contract, or screen... refers to Vehicle, Driver, or Trailer by name").
- Fixed: replaced the road-specific terms with Asset / Operator / Attached Unit throughout the spec set, before any code was written against it, so the schema and API built for the foundation milestone wouldn't inherit the contradiction.
- `03-Hardware/Universal_Vehicle_Hub.md` renamed to `03-Hardware/Universal_Asset_Hub.md` ("Vehicle Hub" → "Asset Hub" throughout) and the "Vehicle Intelligence" subsystem in `01-Product/Product_Overview.md` / `02-Architecture/System_Architecture.md` renamed to "Asset Intelligence" — both were generic-platform naming, not customer-facing brand names, so they fell under the same mandate.
- `11-Database/Data_Model.md`'s core entity list also didn't name an `AssetClass` entity despite `02-Architecture/Asset_Class_Model.md` requiring every Asset to belong to exactly one — added `AssetClass` to the entity list with a short note on how it's used.
- Not touched, deliberately: `CLAUDE.md` and `02-Architecture/Asset_Class_Model.md` (their old-terminology mentions are the explanatory "X → Y" rename documentation and are correct as written), and `CHANGELOG.md` (append-only historical record — past entries describe what was true/built at the time and aren't rewritten).
- `DriverOS` and `FleetHQ` are unaffected — those are product/app names, not the generic role noun "driver," and are used as proper nouns throughout the repository including `CLAUDE.md` itself.

## 2026-07-13 — Multi-modal (land/air/sea) groundwork added

- Founder direction: FleetOS should be able to expand beyond road vehicles to air and sea in the future.
- Decision: generalize terminology now (Asset, Operator, Attached Unit) rather than rename later; added Asset Class as an abstraction independent of Jurisdiction.
- Added `02-Architecture/Asset_Class_Model.md` and `18-Future/Multi_Modal_Expansion.md`.
- Explicitly not building Air or Sea now — Land remains the only implemented Asset Class. This is a terminology/architecture decision, not a scope increase.
