import { Controller, Get, Query } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminSearchService } from './admin-search.service';

/**
 * See AdminAuthController's docstring for why every route here is `@Public()`.
 * Gated on `organisations:view` (not a new permission) — the entity types it
 * returns (orgs/users/assets) are all readable by the roles that hold it.
 */
@Public()
@Controller({ path: 'admin/search', version: '1' })
export class AdminSearchController {
  constructor(private readonly search: AdminSearchService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ORGANISATIONS_VIEW)
  @Get()
  find(@Query('q') q?: string) {
    return this.search.search(q);
  }
}
