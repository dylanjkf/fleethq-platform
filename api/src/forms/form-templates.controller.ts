import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { RequireFeature } from '../common/decorators/require-feature.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { FormsService } from './forms.service';
import { CreateFormTemplateDto } from './dto/create-form-template.dto';
import { UpdateFormTemplateDto } from './dto/update-form-template.dto';
import { ListFormTemplatesDto } from './dto/list-form-templates.dto';

/**
 * Auth/Billing Platform Phase 9 (usage & feature limit depth): `forms` is a
 * declared plan feature (`plans.ts`) that had never actually been enforced
 * server-side — every tier's `features` array included/excluded it, but no
 * `@RequireFeature` gate existed anywhere in this module, so a Free-tier
 * company could reach it by calling the API directly. Mirrors Warehouse's
 * own controller-level gate exactly; inert until `BILLING_ENFORCED=true`.
 */
@RequireFeature('forms')
@Controller({ path: 'form-templates', version: '1' })
export class FormTemplatesController {
  constructor(private readonly forms: FormsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.FORMS_CREATE)
  create(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: CreateFormTemplateDto) {
    return this.forms.createTemplate(user.companyId, user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.FORMS_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListFormTemplatesDto) {
    return this.forms.findAllTemplates(user.companyId, query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.FORMS_VIEW)
  findOne(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.forms.findOneTemplate(user.companyId, id);
  }

  /**
   * The template's reference document. `forms:view`, not `documents:view` — the
   * person filling the form in must be able to read the instruction attached to
   * it.
   */
  @Get(':id/reference')
  @RequirePermission(PERMISSIONS.FORMS_VIEW)
  async downloadReference(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const file = await this.forms.downloadTemplateReference(user.companyId, id);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(file.data);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.FORMS_EDIT)
  update(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFormTemplateDto,
  ) {
    return this.forms.updateTemplate(user.companyId, user.userId, id, dto);
  }

  @Post(':id/archive')
  @RequirePermission(PERMISSIONS.FORMS_ARCHIVE)
  archive(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.forms.archiveTemplate(user.companyId, user.userId, id);
  }
}
