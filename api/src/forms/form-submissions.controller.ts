import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { FormsService } from './forms.service';
import { SubmitFormDto } from './dto/submit-form.dto';
import { ListFormSubmissionsDto } from './dto/list-form-submissions.dto';

@Controller({ path: 'form-submissions', version: '1' })
export class FormSubmissionsController {
  constructor(private readonly forms: FormsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.FORMS_SUBMIT)
  submit(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: SubmitFormDto) {
    return this.forms.submit(user.companyId, user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.FORMS_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListFormSubmissionsDto) {
    return this.forms.findAllSubmissions(user.companyId, query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.FORMS_VIEW)
  findOne(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.forms.findOneSubmission(user.companyId, id);
  }
}
