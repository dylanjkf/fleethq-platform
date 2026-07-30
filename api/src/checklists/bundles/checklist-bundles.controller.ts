import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../../auth/jwt-payload.interface';
import { ChecklistBundlesService } from './checklist-bundles.service';
import { CreateChecklistBundleDto, DeployChecklistBundleDto, UpdateChecklistBundleDto } from './dto/checklist-bundle.dto';

@Controller({ path: 'checklist-bundles', version: '1' })
export class ChecklistBundlesController {
  constructor(private readonly service: ChecklistBundlesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.CHECKLISTS_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.service.findAll(user.companyId);
  }

  @Post()
  @RequirePermission(PERMISSIONS.CHECKLISTS_EDIT)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateChecklistBundleDto) {
    return this.service.create(user.companyId, dto);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CHECKLISTS_EDIT)
  update(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateChecklistBundleDto) {
    return this.service.update(user.companyId, id, dto);
  }

  @Post(':id/deploy')
  @RequirePermission(PERMISSIONS.CHECKLISTS_EDIT)
  deploy(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeployChecklistBundleDto) {
    return this.service.deploy(user.companyId, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.CHECKLISTS_ARCHIVE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.archive(user.companyId, id);
  }
}
