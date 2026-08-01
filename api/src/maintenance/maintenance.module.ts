import { Module } from '@nestjs/common';
import { TimelineModule } from '../timeline/timeline.module';
import { AssetsModule } from '../assets/assets.module';
import { OperatorsModule } from '../operators/operators.module';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceService } from './maintenance.service';

@Module({
  imports: [TimelineModule, AssetsModule, OperatorsModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}
