/**
 * Whether MFA enrollment is *required* for FleetHQ staff-console accounts
 * (Round 3 High #1). Every admin account has cross-tenant reach — including the
 * bootstrap-created Super Admin — so a leaked/guessed password with no second
 * factor is a full cross-tenant compromise. This mirrors the customer app's
 * `ENFORCE_ADMIN_MFA` mechanism, which had no equivalent in the admin realm.
 *
 * Default ON. Set `ENFORCE_STAFF_ADMIN_MFA=false` only to stage a rollout (e.g.
 * to let existing accounts enroll before the block turns on). Enforced by
 * AdminPermissionGuard: an admin without MFA is blocked from every route except
 * the @AdminSetupExempt() enrollment/identity/logout routes until they enroll.
 */
export function staffAdminMfaEnforced(): boolean {
  const raw = process.env.ENFORCE_STAFF_ADMIN_MFA;
  if (raw !== undefined) return raw.toLowerCase() !== 'false';
  // Default: ON everywhere except the automated test env. The large existing
  // admin e2e suite signs in with password only (enrolling TOTP per test would
  // add nothing), so forcing enrollment there would break every admin test for
  // no security benefit. The dedicated obligations spec sets this flag
  // explicitly to 'true' to exercise the real enforcement path.
  return process.env.NODE_ENV !== 'test';
}
