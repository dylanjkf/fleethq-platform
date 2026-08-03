/**
 * Whether MFA enrollment is *required* for FleetHQ staff-console accounts.
 *
 * MFA is OPTIONAL by default: every admin can turn it on from Security settings
 * (setup → confirm → backup codes) and, once enabled, is challenged for a code
 * at sign-in — but no account is ever forced to enrol. MFA stays strongly
 * recommended because admin accounts have cross-tenant reach, so an org that
 * wants to mandate it can opt in by setting `ENFORCE_STAFF_ADMIN_MFA=true`;
 * AdminPermissionGuard then blocks an un-enrolled admin from every route except
 * the @AdminSetupExempt() enrolment/identity/logout routes until they enrol.
 */
export function staffAdminMfaEnforced(): boolean {
  // Only an explicit, truthy opt-in turns enforcement on; anything else
  // (unset, "false", empty, or any other value) leaves MFA optional.
  return process.env.ENFORCE_STAFF_ADMIN_MFA?.toLowerCase() === 'true';
}
