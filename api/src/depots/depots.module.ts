import { Module } from '@nestjs/common';
import { TimelineModule } from '../timeline/timeline.module';
import { DepotsService } from './depots.service';
import { DepotsController } from './depots.controller';

@Module({
  imports: [TimelineModule],
  controllers: [DepotsController],
  providers: [DepotsService],
  exports: [DepotsService],
})
export class DepotsModule {}
