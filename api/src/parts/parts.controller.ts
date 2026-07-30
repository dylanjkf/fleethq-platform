import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { PartsService } from './parts.service';
import { CreatePartDto } from './dto/create-part.dto';
import { UpdatePartDto } from './dto/update-part.dto';

@Controller({ path: 'parts', version: '1' })
export class PartsController {
  constructor(private readonly partsService: PartsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.PARTS_CREATE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreatePartDto) {
    return this.partsService.create(user.companyId, user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.PARTS_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListQueryDto) {
    return this.partsService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.PARTS_VIEW)
  findOne(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.partsService.findOne(user.companyId, id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.PARTS_EDIT)
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePartDto,
  ) {
    return this.partsService.update(user.companyId, user.userId, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.PARTS_ARCHIVE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.partsService.archive(user.companyId, user.userId, id);
  }
}
