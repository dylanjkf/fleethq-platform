import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { BillingService } from './billing.service';
import { BillingMailService } from './billing-mail.service';
import { EntitlementsService } from './entitlements.service';
import { BillingController } from './billing.controller';

@Module({
  imports: [NotificationsModule],
  controllers: [BillingController],
  providers: [BillingService, BillingMailService, EntitlementsService],
  exports: [BillingService, EntitlementsService],
})
export class BillingModule {}
