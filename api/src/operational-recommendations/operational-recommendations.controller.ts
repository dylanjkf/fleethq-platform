import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { OperationalRecommendationsService } from './operational-recommendations.service';
import { AssetRecommendationsQueryDto } from './dto/asset-recommendations-query.dto';

@Controller({ path: 'operational-recommendations', version: '1' })
export class OperationalRecommendationsController {
  constructor(private readonly recommendationsService: OperationalRecommendationsService) {}

  @Get('assets-for-job')
  @RequirePermission(PERMISSIONS.DISPATCH_VIEW)
  getAssetRecommendations(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: AssetRecommendationsQueryDto) {
    return this.recommendationsService.getAssetRecommendations(user.companyId, query.excludeJobId);
  }

  @Get('maintenance-priority')
  @RequirePermission(PERMISSIONS.MAINTENANCE_VIEW)
  getMaintenancePriority(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.recommendationsService.getMaintenancePriority(user.companyId);
  }
}
