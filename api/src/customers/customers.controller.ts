import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@Controller({ path: 'customers', version: '1' })
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Post()
  @RequirePermission(PERMISSIONS.CUSTOMERS_CREATE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateCustomerDto) {
    return this.customersService.create(user.companyId, user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.CUSTOMERS_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListQueryDto) {
    return this.customersService.findAll(user.companyId, query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CUSTOMERS_VIEW)
  findOne(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.customersService.findOne(user.companyId, id);
  }

  @Get(':id/deliveries')
  @RequirePermission(PERMISSIONS.CUSTOMERS_VIEW)
  deliveries(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.customersService.deliveries(user.companyId, id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CUSTOMERS_EDIT)
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customersService.update(user.companyId, user.userId, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.CUSTOMERS_ARCHIVE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.customersService.archive(user.companyId, user.userId, id);
  }
}
