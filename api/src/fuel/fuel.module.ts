import { Module } from '@nestjs/common';
import { TimelineModule } from '../timeline/timeline.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { FuelController } from './fuel.controller';
import { FuelService } from './fuel.service';

@Module({
  imports: [TimelineModule, AttachmentsModule],
  controllers: [FuelController],
  providers: [FuelService],
  exports: [FuelService],
})
export class FuelModule {}
