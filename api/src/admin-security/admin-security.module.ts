import { Module } from '@nestjs/common';
import { AdminSecurityController } from './admin-security.controller';
import { AdminSecurityService } from './admin-security.service';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';

/** AdminAuditModule is required by AdminPermissionGuard's DI — every AdminGuarded() controller's module needs it. */
@Module({
  imports: [AdminAuditModule],
  controllers: [AdminSecurityController],
  providers: [AdminSecurityService],
})
export class AdminSecurityModule {}
