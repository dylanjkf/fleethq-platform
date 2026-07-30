import { Controller, Get, HttpCode, HttpStatus, Ip, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { AuthenticatedAdminRequestUser } from '../admin-auth/admin-jwt-payload.interface';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminCustomerUsersService } from './admin-customer-users.service';

/** See AdminAuthController's docstring for why every route here is `@Public()` from the customer stack's perspective. */
@Public()
@Controller({ path: 'admin/customer-users', version: '1' })
export class AdminCustomerUsersController {
  constructor(private readonly customerUsers: AdminCustomerUsersService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.CUSTOMER_USERS_VIEW)
  @Get(':userId')
  getById(@Param('userId') userId: string) {
    return this.customerUsers.getById(userId);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.CUSTOMER_USERS_MANAGE)
  @Post(':userId/disable')
  @HttpCode(HttpStatus.OK)
  async disable(@Param('userId') userId: string, @CurrentAdmin() admin: AuthenticatedAdminRequestUser, @Ip() ip: string, @Req() req: Request) {
    await this.customerUsers.disable(userId, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
    return { ok: true };
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.CUSTOMER_USERS_MANAGE)
  @Post(':userId/reactivate')
  @HttpCode(HttpStatus.OK)
  async reactivate(@Param('userId') userId: string, @CurrentAdmin() admin: AuthenticatedAdminRequestUser, @Ip() ip: string, @Req() req: Request) {
    await this.customerUsers.reactivate(userId, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
    return { ok: true };
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.CUSTOMER_USERS_MANAGE)
  @Post(':userId/unlock')
  @HttpCode(HttpStatus.OK)
  async unlock(@Param('userId') userId: string, @CurrentAdmin() admin: AuthenticatedAdminRequestUser, @Ip() ip: string, @Req() req: Request) {
    await this.customerUsers.unlock(userId, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
    return { ok: true };
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.CUSTOMER_USERS_MANAGE)
  @Post(':userId/reset-mfa')
  @HttpCode(HttpStatus.OK)
  async resetMfa(@Param('userId') userId: string, @CurrentAdmin() admin: AuthenticatedAdminRequestUser, @Ip() ip: string, @Req() req: Request) {
    await this.customerUsers.resetMfa(userId, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
    return { ok: true };
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.CUSTOMER_USERS_MANAGE)
  @Post(':userId/send-password-reset')
  @HttpCode(HttpStatus.OK)
  sendPasswordReset(@Param('userId') userId: string, @CurrentAdmin() admin: AuthenticatedAdminRequestUser, @Ip() ip: string, @Req() req: Request) {
    return this.customerUsers.sendPasswordReset(userId, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }
}
