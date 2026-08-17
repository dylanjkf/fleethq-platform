# Authentication & password security

## Intent

Authentication is the front door to every tenant's data. The goal is that
credentials are strong, stored so a database compromise does not yield usable
passwords, resistant to online guessing, and that a session can be revoked
promptly when a credential is suspected compromised.

## What's implemented

- **Passwords hashed with bcrypt (cost factor 10).** Every place a password is
  set hashes it with bcrypt before storage — signup, admin create/invite, reset,
  and operator-link — so the database never holds a plaintext or reversibly-
  encrypted password. `apps/api/src/auth/auth.service.ts` (reset:
  `bcrypt.hash(newPassword, 10)`), `apps/api/src/users/users.service.ts`,
  `apps/api/src/companies/provision-company.ts`. Cost 10 is the accepted
  OWASP-baseline minimum.
- **Password strength policy.** A shared `@IsStrongPassword()` validator
  (≥ 8 characters AND all four character classes — lowercase, uppercase, a
  number, and a symbol — and not on a common-password denylist) guards every
  password-setting DTO, replacing a bare minimum-length check.
  `apps/api/src/common/validators/is-strong-password.validator.ts`
  (unit-tested in the adjacent `.spec.ts`).
- **Brute-force lockout.** `AuthService` counts consecutive failed logins per
  user and locks the account for a fixed window after `MAX_FAILED_LOGINS = 5`;
  a successful login clears the counter. `apps/api/src/auth/auth.service.ts`
  (`recordFailedLogin`, `lockedUntil`, `failedLoginCount`). This sits on top of
  the per-IP rate limit on the credential endpoints (`AUTH_THROTTLE` in
  `apps/api/src/auth/auth.controller.ts`).
- **Failed logins and lockouts are audited.** Each failed attempt and each
  lockout is written to the append-only security audit log as a system-level
  event, and each success as `auth.login_succeeded` with the client IP and
  request id. `apps/api/src/auth/auth.service.ts` +
  `apps/api/src/audit/audit.service.ts`. See
  [09-security-monitoring-and-audit-logging.md](./09-security-monitoring-and-audit-logging.md).
- **JWT session revocation.** Every session token carries the user's
  `tokenVersion`; `JwtStrategy.validate` re-checks it (and `archivedAt`) on every
  request and rejects a stale token with `TOKEN_REVOKED`. A password reset bumps
  the version, so a reset immediately invalidates every existing session for the
  account, not just after the token's 12h expiry.
  `apps/api/src/auth/strategies/jwt.strategy.ts`.
- **JWT verification algorithm pinned.** The strategy accepts only `HS256`
  (`algorithms: ['HS256']`), foreclosing algorithm-substitution attacks
  (`alg:none`, or an RS256 token verified against the HMAC secret). Tokens are
  signed with the symmetric secret from `JWT_SECRET`, which is validated as
  strong (≥ 32 chars, not the in-repo placeholder) in production — see
  [02-secure-configuration.md](./02-secure-configuration.md).
- **No account enumeration on recovery flows.** `forgot-password`,
  `verify-email`, and `resend-verification` always return `{ ok: true }`
  regardless of whether the account exists. `apps/api/src/auth/auth.controller.ts`.
- **Passwords never logged.** `nestjs-pino` redacts the `authorization` header
  and no serializer logs request bodies, so credentials do not reach the logs.
- **Multi-factor authentication (TOTP + WebAuthn/passkeys).** MFA is implemented,
  not planned: time-based one-time passwords (RFC 6238) with single-use recovery
  codes, plus WebAuthn/passkey registration and assertion. Enrolment, verification,
  and the login step-up are enforced server-side — a session is not issued until the
  MFA challenge is satisfied. `apps/api/src/auth/mfa/`, `apps/api/src/auth/webauthn/`.
- **Admin-tier MFA enforcement, on by default.** Any membership holding an
  admin-tier permission is forced through the MFA gate before a session is issued,
  independent of whether the company has opted into org-wide MFA. Companies can
  additionally set a per-organisation *mandatory MFA* policy.
  `apps/api/src/auth/auth-policy-gate.service.ts`,
  `apps/api/src/security-settings/`.
- **Authenticated self-service password change.** A logged-in user can rotate their
  own password by re-proving the current one; the change bumps `tokenVersion`
  (revoking other live sessions) and sends a security notification.
  `apps/api/src/auth/auth.service.ts` (`changePassword`).

## Gaps & residual risk

| Gap | Severity | Plan |
|-----|----------|------|
| No refresh-token rotation or reuse detection. Access is a single bearer JWT with server-side `tokenVersion` revocation but no rotating refresh token, so a stolen token is valid for its full lifetime until a `tokenVersion` bump. | medium | Add a rotating refresh-token scheme with reuse detection; keep `tokenVersion` as the immediate global-revocation lever. |
| No step-up re-authentication for a small set of the most sensitive self-service actions beyond those already covered (password change, MFA enable/disable, and — after this remediation — passkey registration and first-time OAuth link all re-prove a credential). | low | Extend the same re-auth pattern to any future high-value self-service mutation. |
| No enterprise SSO / SAML / OIDC-federation or SCIM provisioning. Social login (Google/Microsoft) exists for consumer sign-in but is not enterprise SSO. | low | Deferred — out of scope for the current courier-vertical buyer; revisit with the first SSO-requiring customer. |
| Password-reset issuance is IP-throttled but not per-account. `forgotPassword` issues a new token per request without invalidating prior ones. | low | Invalidate outstanding reset tokens for the account on each new issue, and add a per-account issuance cooldown. |
| bcrypt work factor is hardcoded to `10` and duplicated across ~4 call sites. | low | Centralise the cost as a single constant and raise toward 12 as hardware allows; re-hash on next successful login. |

## Standards mapping

**Cyber Essentials:** *User access control* (authentication). Strong on password
quality, storage, and brute-force resistance; **MFA is met** — TOTP and
WebAuthn/passkeys are implemented, with admin-tier enforcement on by default,
satisfying the scheme's requirement for a second factor on administrative access
to cloud services.

**ISO/IEC 27001:2022 Annex A:** A.5.17 (authentication information) — hashing,
strength policy, and no-plaintext storage are in place; A.8.5 (secure
authentication) — met on the multi-factor and step-up dimensions (TOTP/WebAuthn,
login step-up, admin-tier enforcement). The remaining residual is refresh-token
rotation, tracked as a gap above.

**SOC 2 (2017 TSC):** CC6.1 (logical access — identification & authentication).
Credential handling, MFA (TOTP + WebAuthn), and session revocation are all
implemented; the principal remaining hardening item a service auditor would note
is refresh-token rotation/reuse detection rather than a missing second factor.
