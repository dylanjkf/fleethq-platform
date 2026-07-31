import { Module } from '@nestjs/common';
import { AdminAnnouncementsController } from './admin-announcements.controller';
import { AdminOrganisationNotesController } from './admin-organisation-notes.controller';
import { AdminSupportService } from './admin-support.service';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';

@Module({
  imports: [AdminAuditModule],
  controllers: [AdminAnnouncementsController, AdminOrganisationNotesController],
  providers: [AdminSupportService],
  exports: [AdminSupportService],
})
export class AdminSupportModule {}
