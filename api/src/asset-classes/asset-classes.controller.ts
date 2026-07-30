import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { AssetClassesService } from './asset-classes.service';
import { CreateAssetClassDto, UpdateAssetClassDto } from './dto/asset-class.dto';

@Controller({ path: 'asset-classes', version: '1' })
export class AssetClassesController {
  constructor(private readonly service: AssetClassesService) {}

  /**
   * Anyone who can see assets can read the category list (the asset form needs
   * it). `includeHidden=true` additionally returns built-ins this company has
   * removed, flagged `isHidden`, so the settings screen can offer "restore" —
   * pickers leave it off and never see a removed category.
   */
  @Get()
  @RequirePermission(PERMISSIONS.ASSETS_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query('includeHidden') includeHidden?: string) {
    return this.service.findAll(user.companyId, { includeHidden: includeHidden === 'true' });
  }

  @Post()
  @RequirePermission(PERMISSIONS.ASSET_CLASS_MANAGE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateAssetClassDto) {
    return this.service.create(user.companyId, dto);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.ASSET_CLASS_MANAGE)
  update(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAssetClassDto) {
    return this.service.update(user.companyId, id, dto);
  }

  /**
   * Remove a category from this company. Works for a built-in too: the shared
   * row is suppressed for this company rather than archived (which would remove
   * it for every tenant). Kept at `/archive` for client compatibility.
   */
  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.ASSET_CLASS_MANAGE)
  remove(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(user.companyId, id);
  }

  /** Bring back a category this company removed. */
  @Post(':id/restore')
  @RequirePermission(PERMISSIONS.ASSET_CLASS_MANAGE)
  restore(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.restore(user.companyId, id);
  }
}
