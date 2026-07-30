import { Module } from '@nestjs/common';
import { PredictiveMaintenanceController } from './predictive-maintenance.controller';
import { PredictiveMaintenanceService } from './predictive-maintenance.service';

@Module({
  controllers: [PredictiveMaintenanceController],
  providers: [PredictiveMaintenanceService],
  exports: [PredictiveMaintenanceService],
})
export class PredictiveMaintenanceModule {}
