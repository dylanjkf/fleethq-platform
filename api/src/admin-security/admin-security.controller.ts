import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminSecurityService } from './admin-security.service';

/** See AdminAuthController's docstring for why every route here is `@Public()` from the customer stack's perspective. */
@Public()
@Controller({ path: 'admin/security', version: '1' })
export class AdminSecurityController {
  constructor(private readonly security: AdminSecurityService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.SECURITY_VIEW)
  @Get('overview')
  overview() {
    return this.security.overview();
  }
}
