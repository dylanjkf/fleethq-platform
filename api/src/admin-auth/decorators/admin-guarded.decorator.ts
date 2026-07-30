import { applyDecorators, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';

/**
 * Shorthand for the pair every authenticated /admin/v1 route needs:
 * `AdminJwtAuthGuard` (validate the admin-jwt bearer token) then
 * `AdminPermissionGuard` (enforce whatever `@AdminAuthenticatedOnly()` /
 * `@RequireAdminPermission()` the route also carries). Still combine with
 * exactly one of those two classification decorators — this only wires the
 * guards, it doesn't classify the route.
 */
export const AdminGuarded = () => applyDecorators(UseGuards(AdminJwtAuthGuard, AdminPermissionGuard));
