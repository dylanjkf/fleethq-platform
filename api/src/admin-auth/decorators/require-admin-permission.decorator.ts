import { SetMetadata } from '@nestjs/common';
import { AdminPermissionKey } from '../../common/permissions/admin-permission-catalog';

export const REQUIRED_ADMIN_PERMISSION_KEY = 'requiredAdminPermission';

/**
 * Marks an /admin/v1 route as requiring a specific granted admin permission.
 * Enforced server-side by AdminPermissionGuard on every request — same
 * deny-by-default posture as the customer API's @RequirePermission: no
 * feature here is gated by a hardcoded role name check.
 */
export const RequireAdminPermission = (permission: AdminPermissionKey) =>
  SetMetadata(REQUIRED_ADMIN_PERMISSION_KEY, permission);
