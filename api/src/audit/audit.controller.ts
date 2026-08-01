import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
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

  /**
   * The same trail as the browse, as a CSV download — same audit:view gate,
   * same tenant scoping and filters, just the whole filtered set instead of one
   * page. Mirrors the file-download pattern used elsewhere (@Res + explicit
   * Content-Type / Content-Disposition headers).
   */
  @Get('export')
  @RequirePermission(PERMISSIONS.AUDIT_VIEW)
  async export(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListAuditLogsDto, @Res() res: Response) {
    const { filename, csv } = await this.audit.exportCsv(user.companyId, query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(csv);
  }
}
