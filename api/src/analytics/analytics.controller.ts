import { Body, Controller, Delete, Get, Param, Post, Put, Query, DefaultValuePipe, ParseIntPipe } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { AnalyticsService } from './analytics.service';
import { SetExclusionDto, SetOverrideDto, UpdateAnalyticsSettingsDto } from './dto/analytics.dto';

@Controller({ path: 'analytics', version: '1' })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  // Read: targets/thresholds/overrides drive the dashboard, so any dashboard
  // viewer (assets:view) may read them; only analytics:manage may change them.
  @Get('settings')
  @RequirePermission(PERMISSIONS.ASSETS_VIEW)
  getSettings(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.analytics.getSettings(user.companyId);
  }

  @Put('settings')
  @RequirePermission(PERMISSIONS.ANALYTICS_MANAGE)
  updateSettings(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: UpdateAnalyticsSettingsDto) {
    return this.analytics.updateSettings(user.companyId, user.userId, dto);
  }

  @Post('settings/reset')
  @RequirePermission(PERMISSIONS.ANALYTICS_MANAGE)
  resetSettings(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.analytics.resetSettings(user.companyId, user.userId);
  }

  @Put('overrides/:metric')
  @RequirePermission(PERMISSIONS.ANALYTICS_MANAGE)
  setOverride(@CurrentUser() user: AuthenticatedRequestUser, @Param('metric') metric: string, @Body() dto: SetOverrideDto) {
    return this.analytics.setOverride(user.companyId, user.userId, metric, dto);
  }

  @Delete('overrides/:metric')
  @RequirePermission(PERMISSIONS.ANALYTICS_MANAGE)
  clearOverride(@CurrentUser() user: AuthenticatedRequestUser, @Param('metric') metric: string) {
    return this.analytics.clearOverride(user.companyId, user.userId, metric);
  }

  @Post('history/reset')
  @RequirePermission(PERMISSIONS.ANALYTICS_MANAGE)
  resetHistory(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.analytics.resetHistory(user.companyId, user.userId);
  }

  @Get('snapshots')
  @RequirePermission(PERMISSIONS.ANALYTICS_MANAGE)
  listSnapshots(@CurrentUser() user: AuthenticatedRequestUser, @Query('days', new DefaultValuePipe(14), ParseIntPipe) days: number) {
    return this.analytics.listSnapshots(user.companyId, Math.min(90, Math.max(1, days)));
  }

  @Post('snapshots/:date/exclusion')
  @RequirePermission(PERMISSIONS.ANALYTICS_MANAGE)
  setExclusion(@CurrentUser() user: AuthenticatedRequestUser, @Param('date') date: string, @Body() dto: SetExclusionDto) {
    return this.analytics.setExclusion(user.companyId, user.userId, date, dto.excluded);
  }
}
