import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { AssetsService } from './assets.service';
import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';

/**
 * The Asset registry — the same resource DriverOS, FleetHQ, and a future
 * third-party integration all read/write through (12-API/API_Architecture.md:
 * "there is no privileged internal-only backend path").
 */
@Controller({ path: 'assets', version: '1' })
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.ASSETS_CREATE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateAssetDto) {
    return this.assetsService.create(user.companyId, user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.ASSETS_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListQueryDto) {
    return this.assetsService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.ASSETS_VIEW)
  findOne(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assetsService.findOne(user.companyId, id);
  }

  @Get(':id/detail')
  @RequirePermission(PERMISSIONS.ASSETS_VIEW)
  getDetail(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assetsService.getDetail(user.companyId, id);
  }

  @Get(':id/glovebox')
  @RequirePermission(PERMISSIONS.ASSETS_VIEW)
  getGlovebox(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assetsService.getGlovebox(user.companyId, id);
  }

  /** The scanned file behind a glovebox document — same assets:view gate as the
   *  glovebox, so a driver who can see it can open the scan without needing
   *  blanket attachments:view. Needs a connection; the status/number/expiry the
   *  driver relies on are already cached offline. */
  @Get(':id/glovebox/documents/:documentId/file')
  @RequirePermission(PERMISSIONS.ASSETS_VIEW)
  async getGloveboxDocumentFile(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Res() res: Response,
  ) {
    const file = await this.assetsService.getGloveboxDocumentFile(user.companyId, id, documentId);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(file.data);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.ASSETS_EDIT)
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssetDto,
  ) {
    return this.assetsService.update(user.companyId, user.userId, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.ASSETS_ARCHIVE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assetsService.archive(user.companyId, user.userId, id);
  }
}
