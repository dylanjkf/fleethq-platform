import { Controller, Get } from '@nestjs/common';
import { AuthenticatedOnly } from '../common/decorators/authenticated-only.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { FeatureFlagsService } from './feature-flags.service';

@Controller({ path: 'feature-flags', version: '1' })
export class FeatureFlagsController {
  constructor(private readonly featureFlags: FeatureFlagsService) {}

  /** Every authenticated user of any role sees the same evaluated flags for their own company — no business permission gates this. */
  @AuthenticatedOnly()
  @Get()
  getAll(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.featureFlags.getAllForCompany(user.companyId);
  }
}
