# Device & session management

## Intent

Sessions and the devices that hold them are where a valid credential turns into
standing access. The goal is that a session is bounded in time, can be revoked,
and that the platform is ready to integrate the endpoint- and identity-management
controls (SSO, MDM) that enterprise customers require.

## What's implemented

- **Bounded session lifetime.** Access tokens are short-lived JWTs
  (`JWT_EXPIRES_IN`, 12h in the reference config) with `ignoreExpiration: false`,
  so a token cannot be replayed indefinitely. `apps/api/src/auth/strategies/jwt.strategy.ts`.
- **Server-side revocation via `tokenVersion`.** Every token carries the user's
  `tokenVersion`, re-checked on each request; bumping it (e.g. on password reset)
  invalidates all of that user's live sessions immediately.
  `apps/api/src/auth/strategies/jwt.strategy.ts`,
  `apps/api/prisma/schema.prisma` (`User.tokenVersion`).
- **Immediate access revocation on deactivation.** `JwtStrategy.validate` also
  rejects a token whose user is archived (`archivedAt`), and deactivating a
  membership is recorded as `access.user_access_revoked` in the audit log —
  so revoking a user's access takes effect on their next request, and is
  auditable. `apps/api/src/users/users.service.ts`.
- **Bearer-token model (no ambient session cookie).** Auth is an `Authorization:
  Bearer` JWT, held by the SPA in its token store (`apps/fleethq/src/api/token-store.ts`),
  not an ambient cookie — so there is no session for a cross-site request to ride
  (CSRF is not applicable), and sign-out is a client-side token discard backed by
  the server-side `tokenVersion` revocation above.
- **Login context captured.** The client IP and request id are recorded on
  `auth.login_succeeded` / `auth.login_failed` audit events, giving the raw
  signal a suspicious-login-detection feature would consume.
  `apps/api/src/auth/auth.controller.ts` (`@Ip()`, `@Req()`).

## Controls in place

- **Multi-factor authentication is implemented** (TOTP + WebAuthn/passkeys, with
  admin-tier enforcement on by default and a per-organisation mandatory-MFA policy).
  Full detail in [07](./07-authentication-and-password-security.md);
  `apps/api/src/auth/mfa/`, `apps/api/src/auth/webauthn/`,
  `apps/api/src/security-settings/`.
- **Per-session listing and selective revocation.** Sessions are tracked
  server-side so a user can list their active sessions and revoke a single one
  ("sign out this device") independently of the global `tokenVersion` lever, and a
  concurrent-session cap is enforced. `apps/api/src/auth/auth-sessions.service.ts`.
- **New-device login notification.** A sign-in from an unrecognised device
  triggers a security notification email to the account owner.

## Gaps & residual risk

| Gap | Severity | Plan |
|-----|----------|------|
| Long-lived access token with no refresh-token rotation. A stolen token is valid for its lifetime (up to 12h, or up to 30 days with "remember me") with no sliding re-validation, until a `tokenVersion` bump or explicit session revocation. | medium | Add short-lived access tokens + rotating refresh tokens with reuse detection; retain per-session and `tokenVersion` revocation as the immediate levers. |
| No automated suspicious-login scoring. New-device sign-ins are notified, but the captured login context is not evaluated for new-geo / impossible-travel anomalies. | low | Score the captured login context against recent history and step-up / alert on anomalies. |
| No enterprise SSO / OIDC-federation / SCIM readiness and no device-posture / MDM integration. Social login (Google/Microsoft) exists for consumer sign-in but is not enterprise SSO; the session is a bearer JWT in browser storage. | low | Deferred — add an enterprise OIDC/SAML strategy + SCIM provisioning with the first SSO-requiring customer; device binding is a later, higher-effort item. |
| No idle/absolute session timeout beyond the fixed JWT expiry. | low | Add an idle-timeout on the client and an absolute cap independent of token TTL. |

## Standards mapping

**Cyber Essentials:** *Secure configuration* + *User access control*. Session
bounding, per-session revocation, and MFA are present; enterprise identity
federation (SSO/SCIM) is the remaining, deliberately-deferred gap.

**ISO/IEC 27001:2022 Annex A:** A.8.5 (secure authentication) — met on the MFA and
session-management dimensions; A.8.1 (user endpoint devices) and A.6.7 (remote
working) — largely unaddressed at the platform level (no device posture / MDM
readiness), which is acceptable for a browser-delivered SaaS but limits enterprise
assurance.

**SOC 2 (2017 TSC):** CC6.1, CC6.6 (restricting logical access, incl. from
outside the system boundary). Time-bounded, revocable (globally and per-session)
sessions plus MFA support these; the principal residual is refresh-token rotation
rather than a missing second factor or an inability to selectively revoke.
