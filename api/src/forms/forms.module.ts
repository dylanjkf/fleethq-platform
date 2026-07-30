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
})
export class FormsModule {}
