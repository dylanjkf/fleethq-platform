import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { OperatorsService } from './operators.service';
import { CreateOperatorDto } from './dto/create-operator.dto';
import { UpdateOperatorDto } from './dto/update-operator.dto';
import { LinkOperatorUserDto } from './dto/link-operator-user.dto';

@Controller({ path: 'operators', version: '1' })
export class OperatorsController {
  constructor(private readonly operatorsService: OperatorsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.OPERATORS_CREATE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateOperatorDto) {
    return this.operatorsService.create(user.companyId, user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.OPERATORS_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListQueryDto) {
    return this.operatorsService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.OPERATORS_VIEW)
  findOne(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.operatorsService.findOne(user.companyId, id);
  }

  @Get(':id/glovebox')
  @RequirePermission(PERMISSIONS.OPERATORS_VIEW)
  getGlovebox(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.operatorsService.getGlovebox(user.companyId, id);
  }

  /** The scanned file behind an operator glovebox document — same operators:view
   *  gate as the glovebox itself. Needs a connection. */
  @Get(':id/glovebox/documents/:documentId/file')
  @RequirePermission(PERMISSIONS.OPERATORS_VIEW)
  async getGloveboxDocumentFile(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Res() res: Response,
  ) {
    const file = await this.operatorsService.getGloveboxDocumentFile(user.companyId, id, documentId);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(file.data);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.OPERATORS_EDIT)
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOperatorDto,
  ) {
    return this.operatorsService.update(user.companyId, user.userId, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.OPERATORS_ARCHIVE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.operatorsService.archive(user.companyId, user.userId, id);
  }

  /**
   * Gated on users:create (not just operators:edit) since this genuinely
   * creates a new login identity — the same capability POST /v1/users
   * requires, per 14-Security/Permissions_Model.md's "no feature is gated
   * by a hardcoded role check" applying equally to composite actions.
   */
  @Post(':id/link-user')
  @RequirePermission(PERMISSIONS.USERS_CREATE)
  linkUser(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkOperatorUserDto,
  ) {
    return this.operatorsService.linkUser(user.companyId, user.userId, id, dto);
  }
}
