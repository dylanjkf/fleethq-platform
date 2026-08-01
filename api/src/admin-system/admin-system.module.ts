import { Module } from '@nestjs/common';
import { AdminSystemController } from './admin-system.controller';
import { AdminSystemService } from './admin-system.service';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';

/** AdminAuditModule is required by AdminPermissionGuard's DI — every AdminGuarded() controller's module needs it. */
@Module({
  imports: [AdminAuditModule],
  controllers: [AdminSystemController],
  providers: [AdminSystemService],
})
export class AdminSystemModule {}
