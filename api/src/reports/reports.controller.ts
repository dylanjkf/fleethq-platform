import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { ReportsService } from './reports.service';
import { ImpactReportDto } from './dto/impact-report.dto';
import { OperationsReportDto } from './dto/operations-report.dto';

@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

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
}
