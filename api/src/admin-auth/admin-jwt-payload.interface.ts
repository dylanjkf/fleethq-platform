/**
 * What an admin session JWT carries. Deliberately carries no permissions —
 * same reasoning as the customer JwtPayload: permissions resolve fresh from
 * the database per request (AdminPermissionGuard), so a role change takes
 * effect immediately rather than requiring re-login.
 *
 * `sid` — the AdminSession row id — is what makes per-device session
 * revocation possible: a session can be killed (DELETE /admin/v1/auth/sessions/:id)
 * independent of the JWT's own exp claim, and every request re-checks it.
 */
export interface AdminJwtPayload {
  /** Subject — the AdminUser id. */
  sub: string;
  sid: string;
  /** Token version at issue time — see AdminUser.tokenVersion. */
  tv: number;
}

/**
 * Short-lived token issued after a correct password when the account has MFA
 * enabled but the second factor hasn't been verified yet. Only usable
 * against POST /admin/v1/auth/mfa/verify — grants no access on its own.
 */
export interface AdminMfaChallengePayload {
  sub: string;
  mfa: true;
  /** Client-supplied device fingerprint, carried through so a verified
   *  challenge can register/refresh a trusted device in one round trip. */
  deviceFingerprint?: string;
}

export interface AuthenticatedAdminRequestUser {
  adminUserId: string;
  sessionId: string;
}
