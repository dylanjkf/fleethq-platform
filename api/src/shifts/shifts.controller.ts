import { Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { ShiftsService } from './shifts.service';
import { ListShiftsDto } from './dto/list-shifts.dto';
import { ShiftSummaryDto } from './dto/shift-summary.dto';

@Controller({ path: 'shifts', version: '1' })
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Post('start')
  @RequirePermission(PERMISSIONS.SHIFTS_MANAGE)
  start(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.shifts.start(user.companyId, user.userId);
  }

  @Post('end')
  @RequirePermission(PERMISSIONS.SHIFTS_MANAGE)
  end(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.shifts.end(user.companyId, user.userId);
  }

  @Get('current')
  @RequirePermission(PERMISSIONS.SHIFTS_MANAGE)
  current(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.shifts.current(user.companyId, user.userId);
  }

  @Get('summary')
  @RequirePermission(PERMISSIONS.SHIFTS_VIEW)
  summary(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ShiftSummaryDto) {
    return this.shifts.summary(user.companyId, query);
  }

  @Get()
  @RequirePermission(PERMISSIONS.SHIFTS_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListShiftsDto) {
    return this.shifts.findAll(user.companyId, query);
  }
}
