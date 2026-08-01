import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminSystemService } from './admin-system.service';

/** See AdminAuthController's docstring for why every route here is `@Public()` from the customer stack's perspective. */
@Public()
@Controller({ path: 'admin/system', version: '1' })
export class AdminSystemController {
  constructor(private readonly system: AdminSystemService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.SYSTEM_VIEW)
  @Get('health')
  getHealth() {
    return this.system.getHealth();
  }
}
