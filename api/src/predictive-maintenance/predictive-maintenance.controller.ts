import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { RequireFeature } from '../common/decorators/require-feature.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { PredictiveMaintenanceService } from './predictive-maintenance.service';

/**
 * Auth/Billing Platform Phase 9 (usage & feature limit depth): `intelligence`
 * is a declared plan feature (`plans.ts`) that had never actually been
 * enforced server-side. Mirrors Warehouse's controller-level `@RequireFeature`
 * gate; inert until `BILLING_ENFORCED=true`. The FleetHQ Maintenance page
 * already renders this signal query in its own isolated tab with its own
 * error state (`ErrorState` + retry), so a 402 here degrades to just that one
 * tab, not the whole page.
 */
@RequireFeature('intelligence')
@Controller({ path: 'predictive-maintenance', version: '1' })
export class PredictiveMaintenanceController {
  constructor(private readonly predictiveMaintenanceService: PredictiveMaintenanceService) {}

  @Get('signals')
  @RequirePermission(PERMISSIONS.MAINTENANCE_VIEW)
  getSignals(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.predictiveMaintenanceService.getSignals(user.companyId);
  }
}
