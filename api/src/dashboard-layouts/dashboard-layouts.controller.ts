import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedOnly } from '../common/decorators/authenticated-only.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { DashboardLayoutsService } from './dashboard-layouts.service';
import { CreatePresetDto, DeployPresetDto, SetLayoutDto, UpdatePresetDto } from './dto/dashboard-layout.dto';

@Controller({ path: 'dashboard', version: '1' })
export class DashboardLayoutsController {
  constructor(private readonly service: DashboardLayoutsService) {}

  // The caller's own layout — no special permission, like notification prefs.
  @Get('layout')
  @AuthenticatedOnly()
  getMyLayout(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.service.getMyLayout(user.companyId, user.membershipId);
  }

  @Put('layout')
  @AuthenticatedOnly()
  setMyLayout(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: SetLayoutDto) {
    return this.service.setMyLayout(user.companyId, user.membershipId, dto);
  }

  // Presets — admin-managed and deployable.
  @Get('layout-presets')
  @RequirePermission(PERMISSIONS.DASHBOARD_MANAGE)
  listPresets(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.service.listPresets(user.companyId);
  }

  @Post('layout-presets')
  @RequirePermission(PERMISSIONS.DASHBOARD_MANAGE)
  createPreset(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreatePresetDto) {
    return this.service.createPreset(user.companyId, dto);
  }

  @Patch('layout-presets/:id')
  @RequirePermission(PERMISSIONS.DASHBOARD_MANAGE)
  updatePreset(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePresetDto) {
    return this.service.updatePreset(user.companyId, id, dto);
  }

  @Post('layout-presets/:id/deploy')
  @RequirePermission(PERMISSIONS.DASHBOARD_MANAGE)
  deployPreset(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeployPresetDto) {
    return this.service.deployPreset(user.companyId, id, dto);
  }

  @Post('layout-presets/:id/archive')
  @RequirePermission(PERMISSIONS.DASHBOARD_MANAGE)
  archivePreset(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.archivePreset(user.companyId, id);
  }
}
