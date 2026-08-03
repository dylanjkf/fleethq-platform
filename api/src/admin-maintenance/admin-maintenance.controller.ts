import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminMaintenanceService } from './admin-maintenance.service';
import { ListMaintenanceDto } from './dto/list-maintenance.dto';

/** See AdminAuthController's docstring for why every route here is `@Public()` from the customer stack's perspective. */
@Public()
@Controller({ path: 'admin/maintenance', version: '1' })
export class AdminMaintenanceController {
  constructor(private readonly maintenance: AdminMaintenanceService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.MAINTENANCE_VIEW)
  @Get()
  list(@Query() query: ListMaintenanceDto) {
    return this.maintenance.list(query);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.MAINTENANCE_VIEW)
  @Get(':id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.maintenance.getById(id);
  }
}
