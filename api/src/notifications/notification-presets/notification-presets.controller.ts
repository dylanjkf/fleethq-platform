import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../../auth/jwt-payload.interface';
import { NotificationPresetsService } from './notification-presets.service';
import { CreateNotificationPresetDto, DeployNotificationPresetDto, UpdateNotificationPresetDto } from './dto/notification-preset.dto';

@Controller({ path: 'notification-presets', version: '1' })
export class NotificationPresetsController {
  constructor(private readonly service: NotificationPresetsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.NOTIFICATIONS_MANAGE)
  findAll(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.service.findAll(user.companyId);
  }

  @Post()
  @RequirePermission(PERMISSIONS.NOTIFICATIONS_MANAGE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateNotificationPresetDto) {
    return this.service.create(user.companyId, dto);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.NOTIFICATIONS_MANAGE)
  update(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateNotificationPresetDto) {
    return this.service.update(user.companyId, id, dto);
  }

  @Post(':id/deploy')
  @RequirePermission(PERMISSIONS.NOTIFICATIONS_MANAGE)
  deploy(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeployNotificationPresetDto) {
    return this.service.deploy(user.companyId, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.NOTIFICATIONS_MANAGE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.archive(user.companyId, id);
  }
}
