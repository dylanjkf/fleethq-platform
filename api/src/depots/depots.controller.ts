import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { DepotsService } from './depots.service';
import { CreateDepotDto } from './dto/create-depot.dto';
import { UpdateDepotDto } from './dto/update-depot.dto';

@Controller({ path: 'depots', version: '1' })
export class DepotsController {
  constructor(private readonly depotsService: DepotsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.DEPOTS_CREATE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateDepotDto) {
    return this.depotsService.create(user.companyId, user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.DEPOTS_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListQueryDto) {
    return this.depotsService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.DEPOTS_VIEW)
  findOne(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.depotsService.findOne(user.companyId, id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.DEPOTS_EDIT)
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDepotDto,
  ) {
    return this.depotsService.update(user.companyId, user.userId, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.DEPOTS_ARCHIVE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.depotsService.archive(user.companyId, user.userId, id);
  }
}
