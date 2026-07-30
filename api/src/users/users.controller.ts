import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { LinkExistingUserDto } from './dto/link-existing-user.dto';

/**
 * "Users" here means company membership records — a User identity can exist
 * across multiple companies (14-Security/Permissions_Model.md), but this
 * resource only ever exposes/manages the slice of that identity relevant to
 * the caller's own company. The `id` in every route below is a
 * CompanyMembership id, not a global User id.
 */
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @RequirePermission(PERMISSIONS.USERS_CREATE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateUserDto) {
    return this.usersService.create(user.companyId, user.userId, dto);
  }

  @Post('link')
  @RequirePermission(PERMISSIONS.USERS_CREATE)
  linkExisting(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: LinkExistingUserDto) {
    return this.usersService.linkExisting(user.companyId, user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.USERS_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListQueryDto) {
    return this.usersService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.USERS_VIEW)
  findOne(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.findOne(user.companyId, id);
  }

  @Patch(':id/role')
  @RequirePermission(PERMISSIONS.USERS_EDIT)
  updateRole(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserRoleDto,
  ) {
    return this.usersService.updateRole(user.companyId, user.userId, id, dto);
  }

  @Post(':id/deactivate')
  @RequirePermission(PERMISSIONS.USERS_ARCHIVE)
  deactivate(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.deactivate(user.companyId, user.userId, id);
  }
}
