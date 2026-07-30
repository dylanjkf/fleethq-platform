import { Module } from '@nestjs/common';
import { TimelineModule } from '../timeline/timeline.module';
import { AttachedUnitsController } from './attached-units.controller';
import { AttachedUnitsService } from './attached-units.service';

@Module({
  imports: [TimelineModule],
  controllers: [AttachedUnitsController],
  providers: [AttachedUnitsService],
  exports: [AttachedUnitsService],
})
export class AttachedUnitsModule {}
