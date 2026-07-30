import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { EXPORT_THROTTLE } from '../common/throttles';
import { PrivacyService } from './privacy.service';

/**
 * 14-Security/Privacy_Data_Protection.md's admin-initiated Australian Privacy
 * Act access/erasure path — deliberately its own controller (not folded into
 * OperatorsController) since export/erase are each their own granular
 * permission, distinct from ordinary operators:view/edit.
 */
// Full-subject export/erasure is expensive and privacy-sensitive; a very low
// rate is plenty for a genuine Privacy Act request and blunts bulk exfiltration.
@Throttle(EXPORT_THROTTLE)
@Controller({ path: 'operators', version: '1' })
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Get(':id/data-export')
  @RequirePermission(PERMISSIONS.PRIVACY_EXPORT_DATA)
  exportData(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.privacy.exportOperatorData(user.companyId, user.userId, id);
  }

  @Post(':id/erase-personal-data')
  @RequirePermission(PERMISSIONS.PRIVACY_ERASE_DATA)
  erase(@CurrentUser() user: AuthenticatedRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.privacy.eraseOperatorData(user.companyId, user.userId, id);
  }
}
