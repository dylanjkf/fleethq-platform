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
  (≥ 8 characters, at least 2 of 4 character classes, and not on a common-password
  denylist) guards every password-setting DTO, replacing a bare minimum-length
  check. `apps/api/src/common/validators/is-strong-password.validator.ts`
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

## Gaps & residual risk

| Gap | Severity | Plan |
|-----|----------|------|
| **No multi-factor authentication anywhere.** Authentication is single-factor password + lockout only; there is no TOTP/WebAuthn/passkey and no MFA columns in the schema. This is the single biggest authentication gap and blocks Cyber Essentials (which requires MFA on cloud admin accounts). | high | Add TOTP (RFC 6238) with enrolment enforcement for privileged roles and recovery codes; add `mfa_secret`/`mfa_enabled` to the User model and a verify step in the login flow. |
| No authenticated self-service password change. A logged-in user cannot rotate their own password — only the email-token reset flow exists. | medium | Add a `change-password` endpoint requiring the current password, reusing the strength validator and bumping `tokenVersion`. |
| Password-reset issuance is IP-throttled but not per-account. `forgotPassword` issues a new token per request without invalidating prior ones. | low | Invalidate outstanding reset tokens for the account on each new issue, and add a per-account issuance cooldown. |
| bcrypt work factor is hardcoded to `10` and duplicated across ~4 call sites. | low | Centralise the cost as a single constant and raise toward 12 as hardware allows; re-hash on next successful login. |

## Standards mapping

**Cyber Essentials:** *User access control* (authentication). Strong on password
quality, storage, and brute-force resistance; **not met** on MFA, which the
scheme requires for administrative access to cloud services.

**ISO/IEC 27001:2022 Annex A:** A.5.17 (authentication information) — hashing,
strength policy, and no-plaintext storage are in place; A.8.5 (secure
authentication) — partially met, with MFA and step-up authentication the notable
absences.

**SOC 2 (2017 TSC):** CC6.1 (logical access — identification & authentication).
Credential handling and session revocation are well-implemented; the lack of MFA
is the principal control weakness a service auditor would flag.
