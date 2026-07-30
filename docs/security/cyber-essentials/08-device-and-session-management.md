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

## Gaps & residual risk

| Gap | Severity | Plan |
|-----|----------|------|
| **No multi-factor authentication.** Single-factor bearer sessions with no second factor at login or step-up for sensitive actions. | high | TOTP/WebAuthn (tracked as the priority item in [07](./07-authentication-and-password-security.md)); step-up re-auth for privilege changes and data export. |
| No per-session logout or session listing. Revocation is coarse — `tokenVersion` is a single per-user counter, so "sign out this one device" or "show my active sessions" is not possible; a bump signs out everywhere. | medium | Introduce a per-session identifier (jti) with a server-side session/revocation table, enabling selective logout and a session list. |
| Long-lived (12h) access token with no refresh-token rotation. A stolen token is valid for up to 12h with no sliding re-validation. | medium | Add short-lived access tokens + rotating refresh tokens with reuse detection. |
| No suspicious-login detection. IP is captured but never evaluated (new-device / new-geo / impossible-travel). | medium | Evaluate the captured login context against recent history and alert / step-up on anomalies. |
| No SSO / OIDC / SCIM readiness and no device-posture / MDM integration. Auth is hardwired to the local password store; the session is an unbound bearer JWT in browser storage. | medium | Add an OIDC strategy + SCIM user provisioning for enterprise identity; device binding is a later, higher-effort item. |
| No idle/absolute session timeout beyond the fixed JWT expiry. | low | Add an idle-timeout on the client and an absolute cap independent of token TTL. |

## Standards mapping

**Cyber Essentials:** *Secure configuration* + *User access control*. Session
bounding and revocation are present; MFA and enterprise identity integration are
the gaps.

**ISO/IEC 27001:2022 Annex A:** A.8.5 (secure authentication) — partial; A.8.1
(user endpoint devices) and A.6.7 (remote working) — largely unaddressed at the
platform level (no device posture / MDM readiness), which is acceptable for a
browser-delivered SaaS but limits enterprise assurance.

**SOC 2 (2017 TSC):** CC6.1, CC6.6 (restricting logical access, incl. from
outside the system boundary). Time-bounded, revocable sessions support these; the
absence of MFA and selective session control are the residual weaknesses.
