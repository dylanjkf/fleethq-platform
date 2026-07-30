import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { CreatePlanDto, CreateTemplateDto, DeployTemplateDto, UpdatePlanDto, UpdateTemplateDto } from './dto/schedule.dto';

/**
 * Maintenance schedules: savable templates + deployable per-asset plans.
 * Read via maintenance:view, manage via maintenance:edit.
 */
@Controller({ path: 'maintenance-schedules', version: '1' })
export class MaintenanceSchedulesController {
  constructor(private readonly service: MaintenanceSchedulesService) {}

  @Get('presets')
  @RequirePermission(PERMISSIONS.MAINTENANCE_VIEW)
  presets() {
    return { items: this.service.presets() };
  }

  // Templates
  @Get('templates')
  @RequirePermission(PERMISSIONS.MAINTENANCE_VIEW)
  listTemplates(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.service.listTemplates(user.companyId);
  }

  @Post('templates')
  @RequirePermission(PERMISSIONS.MAINTENANCE_EDIT)
  createTemplate(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateTemplateDto) {
    return this.service.createTemplate(user.companyId, dto);
  }

  @Patch('templates/:id')
  @RequirePermission(PERMISSIONS.MAINTENANCE_EDIT)
  updateTemplate(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTemplateDto) {
    return this.service.updateTemplate(user.companyId, id, dto);
  }

  @Post('templates/:id/deploy')
  @RequirePermission(PERMISSIONS.MAINTENANCE_EDIT)
  deploy(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeployTemplateDto) {
    return this.service.deployTemplate(user.companyId, id, dto);
  }

  @Post('templates/:id/archive')
  @RequirePermission(PERMISSIONS.MAINTENANCE_EDIT)
  archiveTemplate(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.archiveTemplate(user.companyId, id);
  }

  // Per-asset plans
  @Get('plans')
  @RequirePermission(PERMISSIONS.MAINTENANCE_VIEW)
  listPlans(@CurrentUser() user: AuthenticatedRequestUser, @Query('assetId') assetId?: string) {
    return assetId ? this.service.listPlansForAsset(user.companyId, assetId) : this.service.listAllPlans(user.companyId);
  }

  @Post('plans')
  @RequirePermission(PERMISSIONS.MAINTENANCE_EDIT)
  createPlan(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreatePlanDto) {
    return this.service.createPlan(user.companyId, dto);
  }

  @Patch('plans/:id')
  @RequirePermission(PERMISSIONS.MAINTENANCE_EDIT)
  updatePlan(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlanDto) {
    return this.service.updatePlan(user.companyId, id, dto);
  }

  @Post('plans/:id/service')
  @RequirePermission(PERMISSIONS.MAINTENANCE_EDIT)
  markServiced(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.servicePlan(user.companyId, id);
  }

  @Post('plans/:id/archive')
  @RequirePermission(PERMISSIONS.MAINTENANCE_EDIT)
  archivePlan(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.archivePlan(user.companyId, id);
  }
}
