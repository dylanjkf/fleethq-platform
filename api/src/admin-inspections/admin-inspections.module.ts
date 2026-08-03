import { Module } from '@nestjs/common';
import { AdminInspectionsController } from './admin-inspections.controller';
import { AdminInspectionsService } from './admin-inspections.service';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';

/** AdminAuditModule is required by AdminPermissionGuard's DI — every AdminGuarded() controller's module needs it. */
@Module({
  imports: [AdminAuditModule],
  controllers: [AdminInspectionsController],
  providers: [AdminInspectionsService],
})
export class AdminInspectionsModule {}
