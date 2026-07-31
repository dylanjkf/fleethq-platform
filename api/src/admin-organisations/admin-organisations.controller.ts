import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { ADMIN_SENSITIVE_ACTION_THROTTLE } from '../common/throttles';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { AuthenticatedAdminRequestUser } from '../admin-auth/admin-jwt-payload.interface';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminOrganisationsService } from './admin-organisations.service';
import { AdminOrganisationsQueryDto } from './dto/admin-organisations-query.dto';
import { SuspendOrganisationDto } from './dto/suspend-organisation.dto';
import { UpdateTrialDto } from './dto/update-trial.dto';
import { ImpersonateUserDto } from './dto/impersonate-user.dto';
import { AdminCustomerUsersService } from '../admin-customer-users/admin-customer-users.service';
import { CreateCustomerUserDto } from '../admin-customer-users/dto/create-customer-user.dto';

/** See AdminAuthController's docstring for why every route here is `@Public()` from the customer stack's perspective. */
@Public()
@Controller({ path: 'admin/organisations', version: '1' })
export class AdminOrganisationsController {
  constructor(
    private readonly organisations: AdminOrganisationsService,
    private readonly customerUsers: AdminCustomerUsersService,
  ) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ORGANISATIONS_VIEW)
  @Get()
  list(@Query() query: AdminOrganisationsQueryDto) {
    return this.organisations.list(query);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ORGANISATIONS_VIEW)
  @Get(':id')
  getById(@Param('id') id: string) {
    return this.organisations.getById(id);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ORGANISATIONS_VIEW)
  @Get(':id/roles')
  listRoles(@Param('id') id: string) {
    return this.organisations.listRoles(id);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ORGANISATIONS_SUSPEND)
  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  async suspend(
    @Param('id') id: string,
    @Body() dto: SuspendOrganisationDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    await this.organisations.suspend(id, dto.reason, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
    return { ok: true };
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ORGANISATIONS_SUSPEND)
  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  async restore(
    @Param('id') id: string,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    await this.organisations.restore(id, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
    return { ok: true };
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ORGANISATIONS_ARCHIVE)
  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  async archive(
    @Param('id') id: string,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    await this.organisations.archive(id, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
    return { ok: true };
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ORGANISATIONS_ARCHIVE)
  @Post(':id/unarchive')
  @HttpCode(HttpStatus.OK)
  async unarchive(
    @Param('id') id: string,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    await this.organisations.unarchive(id, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
    return { ok: true };
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ORGANISATIONS_EDIT)
  @Patch(':id/trial')
  updateTrial(
    @Param('id') id: string,
    @Body() dto: UpdateTrialDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.organisations.updateTrial(id, dto.trialEndsAt, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.ORGANISATIONS_IMPERSONATE)
  @Throttle(ADMIN_SENSITIVE_ACTION_THROTTLE)
  @Post(':id/impersonate')
  @HttpCode(HttpStatus.OK)
  impersonate(
    @Param('id') id: string,
    @Body() dto: ImpersonateUserDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.organisations.impersonate(id, dto.userId, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  /**
   * Support scenario: add a user on a customer's behalf (e.g. their only
   * admin left the company). Lives here (not on AdminCustomerUsersController)
   * because the target organisation is the natural scope for "create a user
   * *in this org*" — see AdminCustomerUsersService.createUser for why it
   * writes directly via fleetos_admin rather than the customer UsersService.
   */
  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.CUSTOMER_USERS_MANAGE)
  @Post(':id/users')
  createUser(
    @Param('id') id: string,
    @Body() dto: CreateCustomerUserDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.customerUsers.createUser(id, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }
}
