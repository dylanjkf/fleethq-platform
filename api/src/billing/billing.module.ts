import { Module, forwardRef } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { SignupModule } from '../signup/signup.module';
import { BillingService } from './billing.service';
import { BillingMailService } from './billing-mail.service';
import { EntitlementsService } from './entitlements.service';
import { BillingController } from './billing.controller';

@Module({
  // forwardRef(SignupModule): the payment webhook (here) provisions via
  // SignupService, while signup checkout is created via BillingService — a
  // two-way dependency Nest resolves lazily.
  imports: [NotificationsModule, forwardRef(() => SignupModule)],
  controllers: [BillingController],
  providers: [BillingService, BillingMailService, EntitlementsService],
  exports: [BillingService, EntitlementsService],
})
export class BillingModule {}
