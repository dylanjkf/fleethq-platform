import { Module } from '@nestjs/common';
import { TimelineModule } from '../timeline/timeline.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { FormsService } from './forms.service';
import { FormTemplatesController } from './form-templates.controller';
import { FormSubmissionsController } from './form-submissions.controller';

@Module({
  imports: [TimelineModule, AttachmentsModule],
  controllers: [FormTemplatesController, FormSubmissionsController],
  providers: [FormsService],
  // Exported so DispatchModule's completeStop can validate + record the
  // configured POD evidence in its own transaction (Configurable POD).
  exports: [FormsService],
})
export class FormsModule {}
