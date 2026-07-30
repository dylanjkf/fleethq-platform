import { Module } from '@nestjs/common';
import { TimelineService } from './timeline.service';
import { TimelineQueryService } from './timeline-query.service';
import { TimelineController } from './timeline.controller';

@Module({
  controllers: [TimelineController],
  providers: [TimelineService, TimelineQueryService],
  exports: [TimelineService],
})
export class TimelineModule {}
