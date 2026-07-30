import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

/**
 * Global so any service can record a security event without a web of module
 * imports — the audit trail is a cross-cutting concern (like PrismaService).
 * PrismaModule is global, so SystemPrismaService/PrismaService resolve here.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
