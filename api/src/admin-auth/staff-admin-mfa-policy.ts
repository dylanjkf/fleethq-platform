/**
 * Whether MFA enrollment is *required* for FleetHQ staff-console accounts.
 *
 * SECURE BY DEFAULT (fail closed). Staff/admin accounts run on the BYPASSRLS
 * connection role and can read every tenant's data, so MFA enrolment is
 * REQUIRED in every real environment. Once required, AdminPermissionGuard
 * blocks an un-enrolled admin from every route except the @AdminSetupExempt()
 * enrolment/identity/logout routes until they enrol.
 *
 * The default is enforcement ON — the mere *absence* of any env var never
 * disables it. A deliberate opt-out is possible for local/dev/staging work by
 * setting `ENFORCE_STAFF_ADMIN_MFA=false`, but that opt-out is honoured ONLY
 * outside production: in production the flag is ignored and enforcement is
 * unconditional, so staff MFA can never be silently turned off there.
 *
 * (This is distinct from the customer-facing "MFA optional after signup" flow:
 * that governs tenant end-users, not cross-tenant staff/admin accounts, and is
 * intentionally unaffected by this policy.)
 */
export function staffAdminMfaEnforced(): boolean {
  // Fail closed: only an explicit opt-out, and only outside production, turns
  // enforcement off. Everything else — unset, "true", empty, any other value,
  // or any value at all in production — leaves MFA required.
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.ENFORCE_STAFF_ADMIN_MFA?.toLowerCase() === 'false'
  ) {
    return false;
  }
  return true;
}
