import { Controller, Get, Query } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { AdminFleetService } from './admin-fleet.service';

/** See AdminAuthController's docstring for why every route here is `@Public()` from the customer stack's perspective. */
@Public()
@Controller({ path: 'admin/fleet', version: '1' })
export class AdminFleetController {
  constructor(private readonly fleet: AdminFleetService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.FLEET_VIEW)
  @Get('assets')
  listAssets(@Query() query: ListQueryDto) {
    return this.fleet.listAssets(query);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.FLEET_VIEW)
  @Get('operators')
  listOperators(@Query() query: ListQueryDto) {
    return this.fleet.listOperators(query);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.FLEET_VIEW)
  @Get('integrations')
  listIntegrations(@Query() query: ListQueryDto) {
    return this.fleet.listIntegrations(query);
  }
}
