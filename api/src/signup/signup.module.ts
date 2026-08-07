import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { SignupController } from './signup.controller';
import { SignupService } from './signup.service';

/**
 * Public self-serve signup. Imports AuthModule (session/token/mail services to
 * log the new admin straight in) and BillingModule (Stripe client + settings +
 * the webhook that provisions). BillingModule ↔ SignupModule is a genuine
 * two-way dependency (signup uses Stripe; the payment webhook provisions), so
 * both sides use forwardRef.
 */
@Module({
  imports: [AuthModule, forwardRef(() => BillingModule)],
  controllers: [SignupController],
  providers: [SignupService],
  exports: [SignupService],
})
export class SignupModule {}
