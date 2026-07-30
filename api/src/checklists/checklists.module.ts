import { Module } from '@nestjs/common';
import { TimelineModule } from '../timeline/timeline.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ChecklistsService } from './checklists.service';
import { ChecklistTemplatesController } from './checklist-templates.controller';
import { ChecklistSubmissionsController } from './checklist-submissions.controller';
import { ChecklistStatusController } from './checklist-status.controller';

@Module({
  imports: [TimelineModule, NotificationsModule],
  controllers: [ChecklistTemplatesController, ChecklistSubmissionsController, ChecklistStatusController],
  providers: [ChecklistsService],
  exports: [ChecklistsService],
})
export class ChecklistsModule {}
