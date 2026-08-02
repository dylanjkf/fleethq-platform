import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { ADMIN_SENSITIVE_ACTION_THROTTLE } from '../common/throttles';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { AuthenticatedAdminRequestUser } from '../admin-auth/admin-jwt-payload.interface';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminUsersService } from './admin-users.service';
import { CreateAdminUserDto } from './dto/create-admin-user.dto';
import { UpdateAdminUserRoleDto } from './dto/update-admin-user-role.dto';
import { ListAdminUsersDto } from './dto/list-admin-users.dto';

/**
 * Manage FleetHQ's own staff accounts (`admin_users:view` / `admin_users:manage`)
 * — the console surface the permission catalog promised but no controller
 * implemented, so a second support hire can be onboarded/offboarded without DB
 * or script access. See AdminAuthController's docstring for why every route
 * here is `@Public()` from the customer stack's perspective; each route still
 * carries `@AdminGuarded()` + a classification decorator (enforced by
 * admin-route-permission-coverage.spec.ts).
 */
@Public()
@Controller({ path: 'admin/users', version: '1' })
export class AdminUsersController {
  constructor(private readonly adminUsers: AdminUsersService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ADMIN_USERS_VIEW)
  @Get()
  list(@Query() query: ListAdminUsersDto) {
    return this.adminUsers.list(query);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ADMIN_USERS_VIEW)
  @Get(':id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminUsers.getById(id);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ADMIN_USERS_MANAGE)
  @Throttle(ADMIN_SENSITIVE_ACTION_THROTTLE)
  @Post()
  create(
    @Body() dto: CreateAdminUserDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.adminUsers.create(dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ADMIN_USERS_MANAGE)
  @Patch(':id/role')
  updateRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdminUserRoleDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.adminUsers.updateRole(id, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ADMIN_USERS_MANAGE)
  @Throttle(ADMIN_SENSITIVE_ACTION_THROTTLE)
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.adminUsers.deactivate(id, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ADMIN_USERS_MANAGE)
  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.adminUsers.reactivate(id, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }
}
