import { Module } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import { AttachmentsController } from './attachments.controller';
import { AttachmentStorage } from './attachment-storage';

@Module({
  controllers: [AttachmentsController],
  providers: [AttachmentsService, AttachmentStorage],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
