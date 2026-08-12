import { Module } from '@nestjs/common';
import { TimelineModule } from '../timeline/timeline.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CustomersModule } from '../customers/customers.module';
import { DepotsModule } from '../depots/depots.module';
import { AssetsModule } from '../assets/assets.module';
import { OperatorsModule } from '../operators/operators.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { FormsModule } from '../forms/forms.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { JobsSupportService } from './jobs.support';
import { JobStopsService } from './job-stops.service';
import { PodReceiptService } from './pod-receipt.service';
import { ParcelsService } from './parcels.service';
import { LoadVerificationService } from './load-verification.service';

@Module({
  imports: [TimelineModule, AttachmentsModule, NotificationsModule, CustomersModule, DepotsModule, AssetsModule, OperatorsModule, ComplianceModule, FormsModule],
  controllers: [JobsController],
  providers: [JobsSupportService, JobsService, JobStopsService, PodReceiptService, ParcelsService, LoadVerificationService],
  exports: [JobsService, JobStopsService],
})
export class DispatchModule {}
