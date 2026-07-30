import { Module } from '@nestjs/common';
import { MaintenanceSchedulesModule } from '../maintenance-schedules/maintenance-schedules.module';
import { DashboardLayoutsController } from './dashboard-layouts.controller';
import { DashboardLayoutsService } from './dashboard-layouts.service';
import { DashboardMetricsController } from './dashboard-metrics.controller';
import { DashboardMetricsService } from './dashboard-metrics.service';

@Module({
  imports: [MaintenanceSchedulesModule],
  controllers: [DashboardLayoutsController, DashboardMetricsController],
  providers: [DashboardLayoutsService, DashboardMetricsService],
  exports: [DashboardMetricsService],
})
export class DashboardLayoutsModule {}
