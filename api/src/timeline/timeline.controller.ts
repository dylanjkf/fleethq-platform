import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { TimelineQueryService } from './timeline-query.service';
import { ListTimelineDto } from './dto/list-timeline.dto';

@Controller({ path: 'timeline', version: '1' })
export class TimelineController {
  constructor(private readonly timelineQuery: TimelineQueryService) {}

  @Get()
  @RequirePermission(PERMISSIONS.TIMELINE_VIEW)
  list(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListTimelineDto) {
    return this.timelineQuery.list(user.companyId, query);
  }

  /** Company-wide recent-activity feed for the dashboard widget. */
  @Get('recent')
  @RequirePermission(PERMISSIONS.TIMELINE_VIEW)
  recent(@CurrentUser() user: AuthenticatedRequestUser, @Query('limit') limit?: string) {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    return this.timelineQuery.recent(user.companyId, Number.isFinite(parsed) ? parsed : undefined);
  }
}
