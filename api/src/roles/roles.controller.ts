import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { CloneRoleDto } from './dto/clone-role.dto';

@Controller({ path: 'roles', version: '1' })
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Post()
  @RequirePermission(PERMISSIONS.ROLES_CREATE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateRoleDto) {
    return this.rolesService.create(user.companyId, user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.ROLES_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListQueryDto) {
    return this.rolesService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.ROLES_VIEW)
  findOne(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.rolesService.findOne(user.companyId, id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.ROLES_EDIT)
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.rolesService.update(user.companyId, user.userId, id, dto);
  }

  @Post(':id/clone')
  @RequirePermission(PERMISSIONS.ROLES_CREATE)
  clone(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloneRoleDto,
  ) {
    return this.rolesService.clone(user.companyId, user.userId, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.ROLES_ARCHIVE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.rolesService.archive(user.companyId, user.userId, id);
  }
}
