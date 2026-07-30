import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { EntitlementsService } from './entitlements.service';
import { BillingController } from './billing.controller';

@Module({
  controllers: [BillingController],
  providers: [BillingService, EntitlementsService],
  exports: [BillingService, EntitlementsService],
})
export class BillingModule {}
