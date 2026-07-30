import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { RetentionModule } from '../retention/retention.module';
import { DashboardLayoutsModule } from '../dashboard-layouts/dashboard-layouts.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { SchedulerService } from './scheduler.service';

/**
 * Background scheduler (opt-in via SCHEDULER_ENABLED). PrismaModule is global,
 * so SystemPrismaService is available without importing it here.
 */
@Module({
  imports: [NotificationsModule, ComplianceModule, RetentionModule, DashboardLayoutsModule, IntegrationsModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
