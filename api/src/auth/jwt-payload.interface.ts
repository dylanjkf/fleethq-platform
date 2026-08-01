/**
 * What a scoped session JWT carries. Deliberately does NOT include the user's
 * resolved permissions — Permissions_Model.md requires permission removals to
 * "take effect promptly... not require a full re-login", so permissions are
 * always resolved fresh from the database per request (see PermissionGuard),
 * never baked into the long-lived token.
 *
 * 12-API/API_Architecture.md: "a multi-company user's token is only ever valid
 * for the company context it was issued for" — hence companyId/membershipId
 * are part of the signed payload, not a client-supplied header.
 */
/** How this login's first factor was satisfied — carried through to
 *  AUDIT_ACTIONS.LOGIN_SUCCEEDED's metadata for a real login-history record. */
export type LoginMethod = 'password' | 'magic_link' | 'oauth_google' | 'oauth_microsoft' | 'webauthn';

export interface JwtPayload {
  /** Subject — the User id. */
  sub: string;
  companyId: string;
  membershipId: string;
  /** Token version at issue time — see User.tokenVersion. The JWT strategy
   *  rejects the token if the user's current version has moved past this
   *  (e.g. after a password reset), giving prompt session revocation. */
  tv: number;
  /** The UserSession row this token belongs to — checked on every request
   *  (revokedAt/expiresAt) independent of the JWT's own signed expiry, which
   *  is what makes per-device session revocation/logout actually work. */
  sid: string;
}

/**
 * Short-lived, narrower token issued after password verification but before a
 * company context is chosen (multi-company login). Only usable against
 * POST /v1/auth/select-company.
 */
export interface PreAuthJwtPayload {
  sub: string;
  preAuth: true;
  /** Carried through from the original login() call so the eventual session
   *  (minted once a company is chosen) still honours "remember me" and the
   *  new-device-login alert, even though those were decided before the
   *  company-choice step. */
  rememberMe?: boolean;
  isNewDeviceLogin?: boolean;
  loginMethod?: LoginMethod;
}

/**
 * Short-lived token issued after a correct first factor (password, magic
 * link, or a linked social account) when the account has MFA enabled but the
 * second factor hasn't been verified yet. Only usable against
 * POST /v1/auth/mfa/verify — it grants no access on its own. A verified
 * WebAuthn/passkey login never reaches this — see AuthService.completeWebauthnLogin's
 * doc comment for why.
 */
export interface MfaChallengePayload {
  sub: string;
  mfa: true;
  /** Client-supplied device fingerprint, carried through so a verified
   *  challenge can register/refresh a trusted device in one round trip. */
  deviceFingerprint?: string;
  rememberMe?: boolean;
  isNewDeviceLogin?: boolean;
  loginMethod?: LoginMethod;
}

/**
 * Short-lived token issued when a login's first factor (and second, if the
 * account itself has MFA enabled) succeeded, but the destination company's
 * own security policy isn't satisfied yet — mandatory MFA not yet enrolled,
 * or the password has aged past that company's expiry window (Auth/Billing
 * Platform Phase 3, 22-Auth-Billing-Platform/Overview.md). Only usable
 * against the matching `POST /v1/auth/mfa-setup/*` or
 * `/v1/auth/password-expired/change` endpoint; carries what's needed to
 * finish issuing the session once the gap is closed — see
 * AuthService.finishLoginForMembership / resolveActiveMembership.
 */
export interface PolicyActionPayload {
  sub: string;
  membershipId: string;
  companyId: string;
  purpose: 'mfa_setup' | 'password_expired';
  rememberMe?: boolean;
  isNewDeviceLogin?: boolean;
  loginMethod?: LoginMethod;
}

export interface AuthenticatedRequestUser {
  userId: string;
  companyId: string;
  membershipId: string;
  /** The UserSession row backing this request's JWT — see JwtPayload.sid. */
  sessionId: string;
}
