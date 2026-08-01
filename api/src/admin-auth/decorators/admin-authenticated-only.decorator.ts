import { SetMetadata } from '@nestjs/common';

export const ADMIN_AUTHENTICATED_ONLY_KEY = 'adminAuthenticatedOnly';

/**
 * Marks an /admin/v1 route as requiring a valid admin session but no specific
 * granted permission — "see my own identity", "list/revoke my own sessions".
 * Same deny-by-default contract as the customer API's @AuthenticatedOnly:
 * AdminPermissionGuard requires every route to declare itself as exactly one
 * of @RequireAdminPermission or @AdminAuthenticatedOnly; anything undeclared
 * is denied rather than silently reachable by any logged-in admin.
 */
export const AdminAuthenticatedOnly = () => SetMetadata(ADMIN_AUTHENTICATED_ONLY_KEY, true);
