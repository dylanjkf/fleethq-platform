import { SetMetadata } from '@nestjs/common';

export const ADMIN_SETUP_EXEMPT_KEY = 'adminSetupExempt';

/**
 * Marks a route as reachable even while the calling admin still has a pending
 * account-setup obligation (a forced password reset, or forced MFA enrollment).
 * AdminPermissionGuard blocks every *other* authenticated route with
 * `ADMIN_SETUP_REQUIRED` until those obligations are cleared — so this decorator
 * belongs only on the handful of routes needed to actually clear them (identity,
 * logout, change-password, MFA setup/enable) plus session listing. Without it the
 * user would be locked out with no way to satisfy the requirement.
 */
export const AdminSetupExempt = () => SetMetadata(ADMIN_SETUP_EXEMPT_KEY, true);
