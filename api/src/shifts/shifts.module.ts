import { Module } from '@nestjs/common';
import { TimelineModule } from '../timeline/timeline.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { ShiftsService } from './shifts.service';
import { ShiftsController } from './shifts.controller';

@Module({
  imports: [TimelineModule, ComplianceModule],
  controllers: [ShiftsController],
  providers: [ShiftsService],
  exports: [ShiftsService],
})
export class ShiftsModule {}
