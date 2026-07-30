import { Module } from '@nestjs/common';
import { TimelineModule } from '../timeline/timeline.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { BillingModule } from '../billing/billing.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';

@Module({
  imports: [TimelineModule, ComplianceModule, BillingModule],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
