import { Module } from '@nestjs/common';
import { TimelineModule } from '../timeline/timeline.module';
import { PartsService } from './parts.service';
import { PartsController } from './parts.controller';

@Module({
  imports: [TimelineModule],
  controllers: [PartsController],
  providers: [PartsService],
  exports: [PartsService],
})
export class PartsModule {}
