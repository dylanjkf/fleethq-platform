import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { SecuritySettingsService } from './security-settings.service';
import { UpdateSecuritySettingsDto } from './dto/security-settings.dto';

@Controller({ path: 'security-settings', version: '1' })
export class SecuritySettingsController {
  constructor(private readonly securitySettings: SecuritySettingsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.SECURITY_POLICY_MANAGE)
  getSettings(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.securitySettings.getSettings(user.companyId);
  }

  @Put()
  @RequirePermission(PERMISSIONS.SECURITY_POLICY_MANAGE)
  updateSettings(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: UpdateSecuritySettingsDto) {
    return this.securitySettings.updateSettings(user.companyId, user.userId, dto);
  }
}
