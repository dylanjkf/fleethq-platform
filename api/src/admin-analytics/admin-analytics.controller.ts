import { Controller, Get, Query } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AnalyticsDaysQueryDto } from './dto/analytics-days-query.dto';

/** See AdminAuthController's docstring for why every route here is `@Public()` from the customer stack's perspective. */
@Public()
@Controller({ path: 'admin/analytics', version: '1' })
export class AdminAnalyticsController {
  constructor(private readonly analytics: AdminAnalyticsService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ANALYTICS_VIEW)
  @Get('overview')
  overview() {
    return this.analytics.overview();
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ANALYTICS_VIEW)
  @Get('signups')
  dailySignups(@Query() query: AnalyticsDaysQueryDto) {
    return this.analytics.dailySignups(query.days);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ANALYTICS_VIEW)
  @Get('trials-expiring')
  trialsExpiring(@Query() query: AnalyticsDaysQueryDto) {
    return this.analytics.trialsExpiring(query.days);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ANALYTICS_VIEW)
  @Get('activity')
  activity() {
    return this.analytics.activity();
  }
}
