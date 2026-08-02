import { Module } from '@nestjs/common';
import { AdminOrganisationsController } from './admin-organisations.controller';
import { AdminOrganisationsService } from './admin-organisations.service';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { AuthModule } from '../auth/auth.module';
import { AdminCustomerUsersModule } from '../admin-customer-users/admin-customer-users.module';
import { TimelineModule } from '../timeline/timeline.module';

/**
 * Imports the customer-facing AuthModule for its `AuthSessionsService.issueSessionToken`
 * — the impersonation feature mints a real customer session token, so it
 * reuses the exact same signing path a normal login uses (short-lived, via
 * an explicit `expiresIn` override) rather than re-implementing JWT signing
 * here under a different key. Also imports AdminCustomerUsersModule so this
 * controller can expose "create a user in this organisation" alongside the
 * rest of an org's lifecycle actions, and TimelineModule so impersonation
 * leaves a marker in the impersonated tenant's own history.
 */
@Module({
  imports: [AdminAuditModule, AuthModule, AdminCustomerUsersModule, TimelineModule],
  controllers: [AdminOrganisationsController],
  providers: [AdminOrganisationsService],
  exports: [AdminOrganisationsService],
})
export class AdminOrganisationsModule {}
