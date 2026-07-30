import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { MaintenanceService } from './maintenance.service';
import { CreateMaintenanceJobDto } from './dto/create-maintenance-job.dto';
import { UpdateMaintenanceJobDto } from './dto/update-maintenance-job.dto';
import { CloseMaintenanceJobDto } from './dto/close-maintenance-job.dto';
import { RecordPartsUsedDto } from './dto/record-parts-used.dto';

@Controller({ path: 'maintenance-jobs', version: '1' })
export class MaintenanceController {
  constructor(private readonly maintenanceService: MaintenanceService) {}

  @Post()
  @RequirePermission(PERMISSIONS.MAINTENANCE_CREATE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateMaintenanceJobDto) {
    return this.maintenanceService.create(user.companyId, user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.MAINTENANCE_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListQueryDto) {
    return this.maintenanceService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.MAINTENANCE_VIEW)
  findOne(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.maintenanceService.findOne(user.companyId, id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.MAINTENANCE_EDIT)
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMaintenanceJobDto,
  ) {
    return this.maintenanceService.update(user.companyId, user.userId, id, dto);
  }

  @Post(':id/approve')
  @RequirePermission(PERMISSIONS.MAINTENANCE_APPROVE)
  approve(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.maintenanceService.approve(user.companyId, user.userId, id);
  }

  @Post(':id/close')
  @RequirePermission(PERMISSIONS.MAINTENANCE_CLOSE)
  close(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseMaintenanceJobDto,
  ) {
    return this.maintenanceService.close(user.companyId, user.userId, id, dto);
  }

  @Post(':id/parts-used')
  @RequirePermission(PERMISSIONS.PARTS_CREATE)
  recordPartsUsed(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordPartsUsedDto,
  ) {
    return this.maintenanceService.recordPartsUsed(user.companyId, user.userId, id, dto);
  }
}
