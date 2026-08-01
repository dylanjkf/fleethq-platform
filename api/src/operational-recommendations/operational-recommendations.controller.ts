import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { RequireFeatureFlag } from '../common/decorators/require-feature-flag.decorator';
import { RequireFeature } from '../common/decorators/require-feature.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { OperationalRecommendationsService } from './operational-recommendations.service';
import { AssetRecommendationsQueryDto } from './dto/asset-recommendations-query.dto';

/**
 * Two independent gates: `operational_recommendations` (the ops kill-switch,
 * unchanged — see below) and, since Auth/Billing Platform Phase 9, the
 * `intelligence` plan feature (`plans.ts`), which had never actually been
 * enforced server-side despite being a declared tier feature. The frontend's
 * `AssignJobDialog` already treats a failed recommendations call as
 * "no recommendation available" (`recommendationsQuery.data ?? []`), so a
 * 402 here degrades gracefully rather than blocking job assignment.
 *
 * Gated on the `operational_recommendations` feature flag
 * (21-Admin-Platform/Overview.md, Phase 5b) — a real, functioning gate, not a
 * decorative one: FleetHQ staff can disable this still-maturing AI-derived
 * feature for one company (or globally) via the admin platform without a
 * deploy. No flag row means "enabled" (FeatureFlagsService fails open), so
 * this behaves exactly as before until an admin actually creates and
 * disables the flag.
 */
@RequireFeatureFlag('operational_recommendations')
@RequireFeature('intelligence')
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
