import { Module } from '@nestjs/common';
import { AdminCustomerUsersController } from './admin-customer-users.controller';
import { AdminCustomerUsersService } from './admin-customer-users.service';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { AuthModule } from '../auth/auth.module';

/**
 * Imports the customer-facing AuthModule for `AuthService.forgotPassword`
 * (send-password-reset delegates to the exact same flow self-service uses)
 * and `AuthTokensService`/`AuthMailService` (the invite-a-user email path in
 * `createUser`) — reused rather than re-implemented, same reasoning as
 * AdminOrganisationsModule's impersonation feature.
 */
@Module({
  imports: [AdminAuditModule, AuthModule],
  controllers: [AdminCustomerUsersController],
  providers: [AdminCustomerUsersService],
  exports: [AdminCustomerUsersService],
})
export class AdminCustomerUsersModule {}
