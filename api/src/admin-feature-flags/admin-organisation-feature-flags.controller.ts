import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { AuthenticatedAdminRequestUser } from '../admin-auth/admin-jwt-payload.interface';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminFeatureFlagsService } from './admin-feature-flags.service';
import { SetOverrideDto } from './dto/set-override.dto';

/** See AdminAuthController's docstring for why every route here is `@Public()` from the customer stack's perspective. */
@Public()
@Controller({ path: 'admin/organisations/:companyId/feature-flags', version: '1' })
export class AdminOrganisationFeatureFlagsController {
  constructor(private readonly featureFlags: AdminFeatureFlagsService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.FEATURE_FLAGS_VIEW)
  @Get()
  list(@Param('companyId', ParseUUIDPipe) companyId: string) {
    return this.featureFlags.listForOrganisation(companyId);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.FEATURE_FLAGS_MANAGE)
  @Put(':flagKey')
  setOverride(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('flagKey') flagKey: string,
    @Body() dto: SetOverrideDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.featureFlags.setOverride(companyId, flagKey, dto.enabled, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.FEATURE_FLAGS_MANAGE)
  @Delete(':flagKey')
  @HttpCode(HttpStatus.OK)
  async clearOverride(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('flagKey') flagKey: string,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    await this.featureFlags.clearOverride(companyId, flagKey, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
    return { ok: true };
  }
}
