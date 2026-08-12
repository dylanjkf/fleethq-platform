import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { ReportsMailService } from './reports-mail.service';
import { WeeklyReportService } from './weekly-report.service';

@Module({
  imports: [NotificationsModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportsMailService, WeeklyReportService],
  // WeeklyReportService is driven by the scheduler's cross-tenant weekly sweep.
  exports: [WeeklyReportService],
})
export class ReportsModule {}
