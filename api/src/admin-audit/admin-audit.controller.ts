import { Controller, Get, Query } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuditLogQueryDto } from './dto/admin-audit-log-query.dto';

/** See AdminAuthController's docstring for why every route here is `@Public()` from the customer stack's perspective. */
@Public()
@Controller({ path: 'admin/audit-log', version: '1' })
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.AUDIT_LOG_VIEW)
  @Get()
  list(@Query() query: AdminAuditLogQueryDto) {
    return this.audit.list(query);
  }
}
