import { Module } from '@nestjs/common';
import { AdminSearchController } from './admin-search.controller';
import { AdminSearchService } from './admin-search.service';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';

/** AdminAuditModule is required by AdminPermissionGuard's DI — every AdminGuarded() controller's module needs it. */
@Module({
  imports: [AdminAuditModule],
  controllers: [AdminSearchController],
  providers: [AdminSearchService],
})
export class AdminSearchModule {}
