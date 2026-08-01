import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { MaintenanceSchedulesController } from './maintenance-schedules.controller';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';

@Module({
  imports: [NotificationsModule],
  controllers: [MaintenanceSchedulesController],
  providers: [MaintenanceSchedulesService],
  exports: [MaintenanceSchedulesService],
})
export class MaintenanceSchedulesModule {}
