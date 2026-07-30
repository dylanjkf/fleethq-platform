import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { AttachedUnitsService } from './attached-units.service';
import { CreateAttachedUnitDto } from './dto/create-attached-unit.dto';
import { UpdateAttachedUnitDto } from './dto/update-attached-unit.dto';
import { HitchAttachedUnitDto } from './dto/hitch-attached-unit.dto';

@Controller({ path: 'attached-units', version: '1' })
export class AttachedUnitsController {
  constructor(private readonly attachedUnitsService: AttachedUnitsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.ATTACHED_UNITS_CREATE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateAttachedUnitDto) {
    return this.attachedUnitsService.create(user.companyId, user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.ATTACHED_UNITS_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListQueryDto) {
    return this.attachedUnitsService.findAll(user.companyId, query);
  }

  /** Full detail for one unit: specs, current hitch, and hitch history. */
  @Get(':id/detail')
  @RequirePermission(PERMISSIONS.ATTACHED_UNITS_VIEW)
  detail(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.attachedUnitsService.detail(user.companyId, id);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.ATTACHED_UNITS_VIEW)
  findOne(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.attachedUnitsService.findOne(user.companyId, id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.ATTACHED_UNITS_EDIT)
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAttachedUnitDto,
  ) {
    return this.attachedUnitsService.update(user.companyId, user.userId, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.ATTACHED_UNITS_ARCHIVE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.attachedUnitsService.archive(user.companyId, user.userId, id);
  }

  /** 01-Product/Fleet_Graph.md's PAIRED_WITH workflow — gated the same as any other change to this record. */
  @Post(':id/hitch')
  @RequirePermission(PERMISSIONS.ATTACHED_UNITS_EDIT)
  hitch(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HitchAttachedUnitDto,
  ) {
    return this.attachedUnitsService.hitch(user.companyId, user.userId, id, dto.assetId);
  }

  @Post(':id/unhitch')
  @RequirePermission(PERMISSIONS.ATTACHED_UNITS_EDIT)
  unhitch(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.attachedUnitsService.unhitch(user.companyId, user.userId, id);
  }
}
