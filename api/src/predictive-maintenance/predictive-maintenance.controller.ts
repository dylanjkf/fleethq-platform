import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { PredictiveMaintenanceService } from './predictive-maintenance.service';

@Controller({ path: 'predictive-maintenance', version: '1' })
export class PredictiveMaintenanceController {
  constructor(private readonly predictiveMaintenanceService: PredictiveMaintenanceService) {}

  @Get('signals')
  @RequirePermission(PERMISSIONS.MAINTENANCE_VIEW)
  getSignals(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.predictiveMaintenanceService.getSignals(user.companyId);
  }
}
