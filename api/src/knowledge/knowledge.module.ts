import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

@Module({
  imports: [AttachmentsModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  // DocumentsModule composes this service for its bulk "publish to the knowledge
  // base" path, so an imported article is created exactly the way a hand-written
  // one is.
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
