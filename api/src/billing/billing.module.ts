import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { BillingService } from './billing.service';
import { EntitlementsService } from './entitlements.service';
import { BillingController } from './billing.controller';

@Module({
  imports: [NotificationsModule],
  controllers: [BillingController],
  providers: [BillingService, EntitlementsService],
  exports: [BillingService, EntitlementsService],
})
export class BillingModule {}
