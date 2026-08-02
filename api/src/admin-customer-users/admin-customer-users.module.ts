import { Module } from '@nestjs/common';
import { AdminCustomerUsersController } from './admin-customer-users.controller';
import { AdminCustomerUsersService } from './admin-customer-users.service';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { AuthModule } from '../auth/auth.module';
import { TimelineModule } from '../timeline/timeline.module';

/**
 * Imports the customer-facing AuthModule for `AuthService.forgotPassword`
 * (send-password-reset delegates to the exact same flow self-service uses)
 * and `AuthTokensService`/`AuthMailService` (the invite-a-user email path in
 * `createUser`) — reused rather than re-implemented, same reasoning as
 * AdminOrganisationsModule's impersonation feature. TimelineModule supplies
 * the one `TimelineService` that writes the tenant's own history, so an
 * admin-created user still lands a `USER created` event in the org's timeline.
 */
@Module({
  imports: [AdminAuditModule, AuthModule, TimelineModule],
  controllers: [AdminCustomerUsersController],
  providers: [AdminCustomerUsersService],
  exports: [AdminCustomerUsersService],
})
export class AdminCustomerUsersModule {}
