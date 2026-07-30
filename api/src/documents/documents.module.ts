import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  imports: [AttachmentsModule, KnowledgeModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
