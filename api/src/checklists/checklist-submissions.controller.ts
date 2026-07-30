import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedOnly } from '../common/decorators/authenticated-only.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { ChecklistsService } from './checklists.service';
import { SubmitChecklistDto } from './dto/submit-checklist.dto';
import { ListChecklistSubmissionsDto } from './dto/list-checklist-submissions.dto';

@Controller({ path: 'checklist-submissions', version: '1' })
export class ChecklistSubmissionsController {
  constructor(private readonly checklists: ChecklistsService) {}

  // Any signed-in user can submit a checklist regardless of role — completing a
  // pre-start is a core field action, so it's intentionally not permission-gated
  // (the JWT auth guard still requires a valid login). Viewing/managing
  // submissions and templates stays gated below.
  @Post()
  @AuthenticatedOnly()
  submit(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: SubmitChecklistDto) {
    return this.checklists.submit(user.companyId, user.userId, dto);
  }

  @Get()
  @RequirePermission(PERMISSIONS.CHECKLISTS_VIEW)
  findAll(@CurrentUser() user: AuthenticatedRequestUser, @Query() query: ListChecklistSubmissionsDto) {
    return this.checklists.findAllSubmissions(user.companyId, query);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CHECKLISTS_VIEW)
  findOne(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.checklists.findOneSubmission(user.companyId, id);
  }
}
