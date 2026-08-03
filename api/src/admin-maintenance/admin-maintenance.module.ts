import { Module } from '@nestjs/common';
import { AdminMaintenanceController } from './admin-maintenance.controller';
import { AdminMaintenanceService } from './admin-maintenance.service';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';

/** AdminAuditModule is required by AdminPermissionGuard's DI — every AdminGuarded() controller's module needs it. */
@Module({
  imports: [AdminAuditModule],
  controllers: [AdminMaintenanceController],
  providers: [AdminMaintenanceService],
})
export class AdminMaintenanceModule {}
