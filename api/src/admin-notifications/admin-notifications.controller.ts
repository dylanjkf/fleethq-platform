import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminNotificationsService } from './admin-notifications.service';

/**
 * See AdminAuthController's docstring for why every route here is `@Public()`.
 * Gated on `analytics:view` (not a new permission) — the alerts feed is the
 * operational companion to the dashboard, so anyone who can see the dashboard
 * (Super Admin + Support) can see it.
 */
@Public()
@Controller({ path: 'admin/notifications', version: '1' })
export class AdminNotificationsController {
  constructor(private readonly notifications: AdminNotificationsService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ANALYTICS_VIEW)
  @Get()
  list() {
    return this.notifications.list();
  }
}
