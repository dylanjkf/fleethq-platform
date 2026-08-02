import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { AuthenticatedAdminRequestUser } from '../admin-auth/admin-jwt-payload.interface';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminFeatureFlagsService } from './admin-feature-flags.service';
import { CreateFeatureFlagDto } from './dto/create-feature-flag.dto';
import { UpdateFeatureFlagDto } from './dto/update-feature-flag.dto';

/** See AdminAuthController's docstring for why every route here is `@Public()` from the customer stack's perspective. */
@Public()
@Controller({ path: 'admin/feature-flags', version: '1' })
export class AdminFeatureFlagsController {
  constructor(private readonly featureFlags: AdminFeatureFlagsService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.FEATURE_FLAGS_VIEW)
  @Get()
  list() {
    return this.featureFlags.list();
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.FEATURE_FLAGS_MANAGE)
  @Post()
  create(@Body() dto: CreateFeatureFlagDto, @CurrentAdmin() admin: AuthenticatedAdminRequestUser, @Ip() ip: string, @Req() req: Request) {
    return this.featureFlags.create(dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.FEATURE_FLAGS_MANAGE)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFeatureFlagDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.featureFlags.update(id, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.FEATURE_FLAGS_MANAGE)
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentAdmin() admin: AuthenticatedAdminRequestUser, @Ip() ip: string, @Req() req: Request) {
    await this.featureFlags.remove(id, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
    return { ok: true };
  }
}
