import { SetMetadata } from '@nestjs/common';
import { PermissionKey } from '../permissions/permission-catalog';

export const REQUIRED_PERMISSION_KEY = 'requiredPermission';

/**
 * Marks a route as requiring a specific granted permission for the caller's
 * active company membership. Enforced by PermissionGuard, server-side, on
 * every request — per 14-Security/Permissions_Model.md: "no feature in the
 * product is gated by a hardcoded role check; all gating resolves through the
 * permission system," and "API calls are rejected server-side for any action
 * the caller's permissions don't cover, regardless of what the UI shows."
 */
export const RequirePermission = (permission: PermissionKey) =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission);
