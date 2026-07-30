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
export interface JwtPayload {
  /** Subject — the User id. */
  sub: string;
  companyId: string;
  membershipId: string;
  /** Token version at issue time — see User.tokenVersion. The JWT strategy
   *  rejects the token if the user's current version has moved past this
   *  (e.g. after a password reset), giving prompt session revocation. */
  tv: number;
}

/**
 * Short-lived, narrower token issued after password verification but before a
 * company context is chosen (multi-company login). Only usable against
 * POST /v1/auth/select-company.
 */
export interface PreAuthJwtPayload {
  sub: string;
  preAuth: true;
}

/**
 * Short-lived token issued after a correct password when the account has MFA
 * enabled but before the second factor has been verified. Only usable against
 * POST /v1/auth/mfa/verify — it grants no access on its own.
 */
export interface MfaChallengePayload {
  sub: string;
  mfa: true;
}

export interface AuthenticatedRequestUser {
  userId: string;
  companyId: string;
  membershipId: string;
}
