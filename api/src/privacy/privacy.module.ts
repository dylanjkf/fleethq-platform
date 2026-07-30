import { Module } from '@nestjs/common';
import { TimelineModule } from '../timeline/timeline.module';
import { PrivacyController } from './privacy.controller';
import { PrivacyService } from './privacy.service';
import { AttachmentStorage } from '../attachments/attachment-storage';

@Module({
  imports: [TimelineModule],
  controllers: [PrivacyController],
  // AttachmentStorage is a self-contained, config-only provider (no DB deps),
  // so providing it directly here is simpler than importing AttachmentsModule
  // and avoids a circular-ish dependency; the erasure path needs it to delete
  // S3-stored scans, not to create attachments.
  providers: [PrivacyService, AttachmentStorage],
})
export class PrivacyModule {}
