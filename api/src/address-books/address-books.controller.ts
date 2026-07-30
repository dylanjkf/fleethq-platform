import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { AddressBooksService } from './address-books.service';
import { CreateAddressBookDto, ImportAddressBookDto, UpdateAddressBookDto } from './dto/address-book.dto';

@Controller({ path: 'address-books', version: '1' })
export class AddressBooksController {
  constructor(private readonly service: AddressBooksService) {}

  @Get()
  @RequirePermission(PERMISSIONS.ADDRESS_BOOK_MANAGE)
  findAll(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.service.findAll(user.companyId);
  }

  @Post()
  @RequirePermission(PERMISSIONS.ADDRESS_BOOK_MANAGE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateAddressBookDto) {
    return this.service.create(user.companyId, dto);
  }

  @Post('import')
  @RequirePermission(PERMISSIONS.ADDRESS_BOOK_MANAGE)
  import(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: ImportAddressBookDto) {
    return this.service.import(user.companyId, dto);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.ADDRESS_BOOK_MANAGE)
  update(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAddressBookDto) {
    return this.service.update(user.companyId, id, dto);
  }

  @Get(':id/export')
  @RequirePermission(PERMISSIONS.ADDRESS_BOOK_MANAGE)
  export(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.export(user.companyId, id);
  }

  @Post(':id/apply')
  @RequirePermission(PERMISSIONS.ADDRESS_BOOK_MANAGE)
  apply(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.apply(user.companyId, user.userId, id);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.ADDRESS_BOOK_MANAGE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.archive(user.companyId, id);
  }
}
