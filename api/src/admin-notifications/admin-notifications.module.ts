import { Module } from '@nestjs/common';
import { AdminNotificationsController } from './admin-notifications.controller';
import { AdminNotificationsService } from './admin-notifications.service';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';

/** AdminAuditModule is required by AdminPermissionGuard's DI — every AdminGuarded() controller's module needs it. */
@Module({
  imports: [AdminAuditModule],
  controllers: [AdminNotificationsController],
  providers: [AdminNotificationsService],
})
export class AdminNotificationsModule {}
