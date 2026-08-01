import { Module } from '@nestjs/common';
import { AdminFeatureFlagsController } from './admin-feature-flags.controller';
import { AdminOrganisationFeatureFlagsController } from './admin-organisation-feature-flags.controller';
import { AdminFeatureFlagsService } from './admin-feature-flags.service';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';

@Module({
  imports: [AdminAuditModule],
  controllers: [AdminFeatureFlagsController, AdminOrganisationFeatureFlagsController],
  providers: [AdminFeatureFlagsService],
  exports: [AdminFeatureFlagsService],
})
export class AdminFeatureFlagsModule {}
