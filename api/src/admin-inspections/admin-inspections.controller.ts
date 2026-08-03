import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminInspectionsService } from './admin-inspections.service';
import { ListInspectionsDto } from './dto/list-inspections.dto';

/** See AdminAuthController's docstring for why every route here is `@Public()` from the customer stack's perspective. */
@Public()
@Controller({ path: 'admin/inspections', version: '1' })
export class AdminInspectionsController {
  constructor(private readonly inspections: AdminInspectionsService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.INSPECTIONS_VIEW)
  @Get()
  list(@Query() query: ListInspectionsDto) {
    return this.inspections.list(query);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.INSPECTIONS_VIEW)
  @Get(':id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.inspections.getById(id);
  }
}
