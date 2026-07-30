import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { GraphQueryService } from './graph-query.service';
import { ListRelationshipsDto } from './dto/list-relationships.dto';

@Controller({ path: 'graph', version: '1' })
export class GraphController {
  constructor(private readonly graphQuery: GraphQueryService) {}

  @Get('relationships')
  @RequirePermission(PERMISSIONS.FLEET_GRAPH_VIEW)
  listRelationships(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListRelationshipsDto) {
    return this.graphQuery.listRelationships(user.companyId, query.entityType, query.entityId);
  }

  /** Company-wide Fleet Graph roll-up for the dashboard widget. */
  @Get('summary')
  @RequirePermission(PERMISSIONS.FLEET_GRAPH_VIEW)
  summary(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.graphQuery.summary(user.companyId);
  }
}
