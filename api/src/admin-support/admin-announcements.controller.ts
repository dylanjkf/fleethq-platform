import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Ip, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { AuthenticatedAdminRequestUser } from '../admin-auth/admin-jwt-payload.interface';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminSupportService } from './admin-support.service';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';

/** See AdminAuthController's docstring for why every route here is `@Public()` from the customer stack's perspective. */
@Public()
@Controller({ path: 'admin/announcements', version: '1' })
export class AdminAnnouncementsController {
  constructor(private readonly support: AdminSupportService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.SUPPORT_VIEW)
  @Get()
  list() {
    return this.support.listAnnouncements();
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.SUPPORT_MANAGE)
  @Post()
  create(@Body() dto: CreateAnnouncementDto, @CurrentAdmin() admin: AuthenticatedAdminRequestUser, @Ip() ip: string, @Req() req: Request) {
    return this.support.createAnnouncement(dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.SUPPORT_MANAGE)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAnnouncementDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.support.updateAnnouncement(id, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.SUPPORT_MANAGE)
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id') id: string, @CurrentAdmin() admin: AuthenticatedAdminRequestUser, @Ip() ip: string, @Req() req: Request) {
    await this.support.deleteAnnouncement(id, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
    return { ok: true };
  }
}
