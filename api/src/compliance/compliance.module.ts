import { Module } from '@nestjs/common';
import { TimelineModule } from '../timeline/timeline.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { FatigueController } from './fatigue.controller';
import { FatigueService } from './fatigue.service';
import { CorEvidenceController } from './cor-evidence.controller';
import { CorEvidenceService } from './cor-evidence.service';
import { FatigueRuleSetsController } from './fatigue-rule-sets/fatigue-rule-sets.controller';
import { FatigueRuleSetsService } from './fatigue-rule-sets/fatigue-rule-sets.service';

@Module({
  imports: [TimelineModule, AttachmentsModule, NotificationsModule],
  controllers: [ComplianceController, FatigueController, CorEvidenceController, FatigueRuleSetsController],
  providers: [ComplianceService, FatigueService, CorEvidenceService, FatigueRuleSetsService],
  exports: [ComplianceService, FatigueService, CorEvidenceService],
})
export class ComplianceModule {}
