import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { MaintenanceSchedulesModule } from '../maintenance-schedules/maintenance-schedules.module';
import { RetentionModule } from '../retention/retention.module';
import { DashboardLayoutsModule } from '../dashboard-layouts/dashboard-layouts.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { SchedulerService } from './scheduler.service';

/**
 * Background scheduler (opt-in via SCHEDULER_ENABLED). PrismaModule is global,
 * so SystemPrismaService is available without importing it here.
 */
@Module({
  imports: [NotificationsModule, ComplianceModule, MaintenanceSchedulesModule, RetentionModule, DashboardLayoutsModule, IntegrationsModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
