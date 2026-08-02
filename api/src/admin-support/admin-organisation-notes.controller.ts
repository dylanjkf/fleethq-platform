import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from '../admin-auth/decorators/admin-guarded.decorator';
import { RequireAdminPermission } from '../admin-auth/decorators/require-admin-permission.decorator';
import { CurrentAdmin } from '../admin-auth/decorators/current-admin.decorator';
import { AuthenticatedAdminRequestUser } from '../admin-auth/admin-jwt-payload.interface';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { AdminSupportService } from './admin-support.service';
import { CreateNoteDto } from './dto/create-note.dto';

/** See AdminAuthController's docstring for why every route here is `@Public()` from the customer stack's perspective. */
@Public()
@Controller({ path: 'admin/organisations/:companyId/notes', version: '1' })
export class AdminOrganisationNotesController {
  constructor(private readonly support: AdminSupportService) {}

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.SUPPORT_VIEW)
  @Get()
  list(@Param('companyId', ParseUUIDPipe) companyId: string) {
    return this.support.listNotes(companyId);
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.SUPPORT_MANAGE)
  @Post()
  add(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: CreateNoteDto,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.support.addNote(companyId, dto, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
  }

  @AdminGuarded()
  @RequireAdminPermission(ADMIN_PERMISSIONS.SUPPORT_MANAGE)
  @Delete(':noteId')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    await this.support.deleteNote(companyId, noteId, { adminUserId: admin.adminUserId, ip, userAgent: req.get('user-agent') });
    return { ok: true };
  }
}
