import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { ChecklistsService } from './checklists.service';

@Controller({ path: 'checklist-status', version: '1' })
export class ChecklistStatusController {
  constructor(private readonly checklists: ChecklistsService) {}

  /** Today's pre-start completion status for every active asset. */
  @Get('today')
  @RequirePermission(PERMISSIONS.CHECKLISTS_VIEW)
  today(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.checklists.todayStatus(user.companyId);
  }
}
