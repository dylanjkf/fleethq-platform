import { Injectable, NotFoundException } from '@nestjs/common';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import { AdminAuditService, ADMIN_AUDIT_ACTIONS } from '../admin-audit/admin-audit.service';
import { AdminActionContext } from '../admin-auth/admin-action-context.interface';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';
import { CreateNoteDto } from './dto/create-note.dto';

/**
 * FleetHQ support tools (21-Admin-Platform/Overview.md, Phase 5a): a
 * customer-visible announcement banner, and staff-internal notes about an
 * organisation. Two very different audiences sharing one module because
 * they're both small, low-traffic "support:view"/"support:manage" surfaces
 * — see the two models' own doc comments in schema.prisma for why one is
 * readable by the customer stack and the other must never be.
 */
@Injectable()
export class AdminSupportService {
  constructor(
    private readonly adminPrisma: AdminPrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  // --- Announcements ---------------------------------------------------

  async listAnnouncements() {
    return this.adminPrisma.announcement.findMany({ orderBy: { createdAt: 'desc' } });
  }

  private async requireAnnouncement(id: string) {
    const announcement = await this.adminPrisma.announcement.findUnique({ where: { id } });
    if (!announcement) throw new NotFoundException({ code: 'ANNOUNCEMENT_NOT_FOUND', message: 'Announcement not found.' });
    return announcement;
  }

  async createAnnouncement(dto: CreateAnnouncementDto, context: AdminActionContext) {
    const announcement = await this.adminPrisma.announcement.create({
      data: {
        title: dto.title,
        body: dto.body,
        severity: dto.severity ?? 'INFO',
        startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
        createdByAdminUserId: context.adminUserId,
      },
    });
    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ANNOUNCEMENT_CREATED,
      entityType: 'announcement',
      entityId: announcement.id,
      ip: context.ip,
      userAgent: context.userAgent,
      afterValue: { title: dto.title, severity: announcement.severity },
    });
    return announcement;
  }

  async updateAnnouncement(id: string, dto: UpdateAnnouncementDto, context: AdminActionContext) {
    const before = await this.requireAnnouncement(id);
    const announcement = await this.adminPrisma.announcement.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.body !== undefined ? { body: dto.body } : {}),
        ...(dto.severity !== undefined ? { severity: dto.severity } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        ...(dto.startsAt !== undefined ? { startsAt: dto.startsAt ? new Date(dto.startsAt) : null } : {}),
        ...(dto.endsAt !== undefined ? { endsAt: dto.endsAt ? new Date(dto.endsAt) : null } : {}),
      },
    });
    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ANNOUNCEMENT_UPDATED,
      entityType: 'announcement',
      entityId: id,
      ip: context.ip,
      userAgent: context.userAgent,
      beforeValue: { title: before.title, active: before.active, severity: before.severity },
      afterValue: { title: announcement.title, active: announcement.active, severity: announcement.severity },
    });
    return announcement;
  }

  async deleteAnnouncement(id: string, context: AdminActionContext) {
    await this.requireAnnouncement(id);
    await this.adminPrisma.announcement.delete({ where: { id } });
    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ANNOUNCEMENT_DELETED,
      entityType: 'announcement',
      entityId: id,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  // --- Organisation notes -----------------------------------------------

  private async requireCompany(companyId: string) {
    const company = await this.adminPrisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!company) throw new NotFoundException({ code: 'ORGANISATION_NOT_FOUND', message: 'Organisation not found.' });
  }

  async listNotes(companyId: string) {
    await this.requireCompany(companyId);
    return this.adminPrisma.adminOrganisationNote.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: { adminUser: { select: { id: true, fullName: true, username: true } } },
    });
  }

  async addNote(companyId: string, dto: CreateNoteDto, context: AdminActionContext) {
    await this.requireCompany(companyId);
    const note = await this.adminPrisma.adminOrganisationNote.create({
      data: { companyId, adminUserId: context.adminUserId, body: dto.body },
    });
    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ORGANISATION_NOTE_ADDED,
      entityType: 'admin_organisation_note',
      entityId: note.id,
      organisationId: companyId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
    return note;
  }

  async deleteNote(companyId: string, noteId: string, context: AdminActionContext) {
    const note = await this.adminPrisma.adminOrganisationNote.findUnique({ where: { id: noteId } });
    if (!note || note.companyId !== companyId) {
      throw new NotFoundException({ code: 'NOTE_NOT_FOUND', message: 'Note not found.' });
    }
    await this.adminPrisma.adminOrganisationNote.delete({ where: { id: noteId } });
    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ORGANISATION_NOTE_DELETED,
      entityType: 'admin_organisation_note',
      entityId: noteId,
      organisationId: companyId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }
}
