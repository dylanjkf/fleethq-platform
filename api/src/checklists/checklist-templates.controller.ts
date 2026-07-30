import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { ChecklistsService } from './checklists.service';
import { CreateChecklistTemplateDto } from './dto/create-checklist-template.dto';
import { UpdateChecklistTemplateDto } from './dto/update-checklist-template.dto';
import { ListChecklistTemplatesDto } from './dto/list-checklist-templates.dto';

@Controller({ path: 'checklist-templates', version: '1' })
export class ChecklistTemplatesController {
  constructor(private readonly checklists: ChecklistsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.CHECKLISTS_CREATE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateChecklistTemplateDto) {
    return this.checklists.createTemplate(user.companyId, user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.CHECKLISTS_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListChecklistTemplatesDto) {
    return this.checklists.findAllTemplates(user.companyId, query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CHECKLISTS_VIEW)
  findOne(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.checklists.findOneTemplate(user.companyId, id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CHECKLISTS_EDIT)
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateChecklistTemplateDto,
  ) {
    return this.checklists.updateTemplate(user.companyId, user.userId, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.CHECKLISTS_ARCHIVE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.checklists.archiveTemplate(user.companyId, user.userId, id);
  }
}
