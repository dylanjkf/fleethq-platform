import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedOnly } from '../common/decorators/authenticated-only.decorator';
import { AuthenticatedRequestUser } from '../auth/jwt-payload.interface';
import { SearchService } from './search.service';

/**
 * No @RequirePermission on this route — search itself isn't a capability
 * (every authenticated user is allowed to search), the *results* are what's
 * permission-filtered, per type, inside SearchService. Same "gate the data,
 * not the door" precedent as GET /v1/notifications.
 */
@Controller({ path: 'search', version: '1' })
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @AuthenticatedOnly()
  query(@CurrentUser() user: AuthenticatedRequestUser, @Query('q') q?: string) {
    return this.search.search(user.companyId, user.membershipId, q ?? '');
  }
}
