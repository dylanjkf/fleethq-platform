import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { AuditService } from './audit.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

@Controller({ path: 'audit-logs', version: '1' })
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** The company's security audit trail — newest first, paginated, RLS-scoped. */
  @Get()
  @RequirePermission(PERMISSIONS.AUDIT_VIEW)
  list(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListAuditLogsDto) {
    return this.audit.list(user.companyId, query);
  }
}
