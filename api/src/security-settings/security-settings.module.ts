import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SecuritySettingsController } from './security-settings.controller';
import { SecuritySettingsService } from './security-settings.service';

@Module({
  imports: [AuditModule],
  controllers: [SecuritySettingsController],
  providers: [SecuritySettingsService],
})
export class SecuritySettingsModule {}
