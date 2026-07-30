import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { DashboardMetricsService } from './dashboard-metrics.service';

const MAX_TREND_DAYS = 90;

@Controller({ path: 'dashboard', version: '1' })
export class DashboardMetricsController {
  constructor(private readonly metrics: DashboardMetricsService) {}

  /** Live operational counts for the ops-snapshot + utilisation widgets. */
  @Get('metrics')
  @RequirePermission(PERMISSIONS.ASSETS_VIEW)
  get(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.metrics.metrics(user.companyId);
  }

  /** The real day-by-day fleet-utilisation trend (accumulated by the scheduler). */
  @Get('utilisation-trend')
  @RequirePermission(PERMISSIONS.ASSETS_VIEW)
  trend(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Query('days', new DefaultValuePipe(14), ParseIntPipe) days: number,
  ) {
    const clamped = Math.min(MAX_TREND_DAYS, Math.max(1, days));
    return this.metrics.trend(user.companyId, clamped);
  }
}
