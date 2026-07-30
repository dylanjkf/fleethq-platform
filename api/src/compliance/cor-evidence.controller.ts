import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { CorEvidenceService } from './cor-evidence.service';

@Controller({ path: 'compliance/cor-evidence', version: '1' })
export class CorEvidenceController {
  constructor(private readonly corEvidenceService: CorEvidenceService) {}

  @Get(':jobId')
  @RequirePermission(PERMISSIONS.COMPLIANCE_VIEW)
  getEvidencePack(@CurrentUser() user: AuthenticatedRequestUser, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.corEvidenceService.getEvidencePack(user.companyId, jobId);
  }
}
