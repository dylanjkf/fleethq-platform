import { Body, Controller, Delete, Get, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { ReportsService } from './reports.service';
import { WeeklyReportService } from './weekly-report.service';
import { ImpactReportDto } from './dto/impact-report.dto';
import { OperationsReportDto } from './dto/operations-report.dto';
import { WeeklyRecipientDto } from './dto/weekly-recipient.dto';

@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly weeklyReport: WeeklyReportService,
  ) {}

  @Get('operations')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  operations(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: OperationsReportDto) {
    return this.reports.operations(user.companyId, query);
  }

  @Get('impact')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  impact(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ImpactReportDto) {
    return this.reports.impact(user.companyId, query);
  }

  // ── Weekly-report recipient list (Part 4) ─────────────────────────────────
  // Managing who receives the scheduled weekly report is a company-settings
  // action, gated on companies:edit (the company-admin-equivalent permission) —
  // not a new parallel permission. When the list is empty, the report falls back
  // to reports:view holders, so the main contacts receive it by default.

  @Get('weekly-recipients')
  @RequirePermission(PERMISSIONS.COMPANIES_EDIT)
  getWeeklyRecipients(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.weeklyReport.getRecipients(user.companyId);
  }

  @Post('weekly-recipients')
  @RequirePermission(PERMISSIONS.COMPANIES_EDIT)
  addWeeklyRecipient(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: WeeklyRecipientDto) {
    return this.weeklyReport.addRecipient(user.companyId, dto.email);
  }

  @Delete('weekly-recipients')
  @RequirePermission(PERMISSIONS.COMPANIES_EDIT)
  removeWeeklyRecipient(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: WeeklyRecipientDto) {
    return this.weeklyReport.removeRecipient(user.companyId, dto.email);
  }
}
