import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { LocationsService } from './locations.service';
import { ReportLocationDto } from './dto/report-location.dto';

@Controller({ path: 'locations', version: '1' })
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  /** A DriverOS operator reports their own current position (while on shift). */
  @Post()
  @RequirePermission(PERMISSIONS.LOCATION_REPORT)
  report(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: ReportLocationDto) {
    return this.locations.report(user.companyId, user.userId, dto);
  }

  /** The office dispatch board reads the fleet's last-known positions. */
  @Get()
  @RequirePermission(PERMISSIONS.LOCATION_VIEW)
  currentFleet(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.locations.currentFleet(user.companyId);
  }
}
