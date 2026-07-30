import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { FuelService } from './fuel.service';
import { CreateFuelEntryDto, ListFuelEntriesDto } from './dto/fuel.dto';

@Controller({ path: 'fuel', version: '1' })
export class FuelController {
  constructor(private readonly fuel: FuelService) {}

  /** Drivers record a purchase from DriverOS (fuel:log). */
  @Post('entries')
  @RequirePermission(PERMISSIONS.FUEL_LOG)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateFuelEntryDto) {
    return this.fuel.create(user.companyId, user.userId, dto);
  }

  /** The office reads the log (fuel:view), newest first, optionally per asset. */
  @Get('entries')
  @RequirePermission(PERMISSIONS.FUEL_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListFuelEntriesDto) {
    return this.fuel.findAll(user.companyId, query);
  }

  /** Spend rollup, aggregated in SQL so it stays correct beyond one page. */
  @Get('summary')
  @RequirePermission(PERMISSIONS.FUEL_VIEW)
  summary(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.fuel.summary(user.companyId);
  }
}
