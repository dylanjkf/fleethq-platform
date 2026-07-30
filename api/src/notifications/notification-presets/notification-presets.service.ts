import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateNotificationPresetDto, DeployNotificationPresetDto, UpdateNotificationPresetDto } from './dto/notification-preset.dto';

/**
 * Savable notification-preference bundles (Saved Layout): a company admin
 * defines a named set of the per-type mute list + digest-only flag once, then
 * deploys it to many members' own preferences in a single action.
 */
@Injectable()
export class NotificationPresetsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(companyId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const items = await tx.notificationPreset.findMany({ where: { archivedAt: null }, orderBy: [{ name: 'asc' }] });
      return { items };
    });
  }

  async create(companyId: string, dto: CreateNotificationPresetDto) {
    return this.prisma.withTenant(companyId, (tx) =>
      tx.notificationPreset.create({
        data: { companyId, name: dto.name.trim(), digestOnly: dto.digestOnly ?? false, mutedTypes: dto.mutedTypes ?? [] },
      }),
    );
  }

  async update(companyId: string, id: string, dto: UpdateNotificationPresetDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.require(tx, companyId, id);
      return tx.notificationPreset.update({
        where: { id },
        data: { name: dto.name?.trim(), digestOnly: dto.digestOnly, mutedTypes: dto.mutedTypes },
      });
    });
  }

  async archive(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const preset = await this.require(tx, companyId, id);
      if (preset.archivedAt) return preset;
      return tx.notificationPreset.update({ where: { id }, data: { archivedAt: new Date() } });
    });
  }

  /** Deploy: write this preset's settings onto the given users' own preferences. */
  async deploy(companyId: string, id: string, dto: DeployNotificationPresetDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const preset = await this.require(tx, companyId, id);
      // Only members of THIS company may be targeted — resolve via membership,
      // never trust the raw user id list (a user id is global).
      const memberships = await tx.companyMembership.findMany({
        where: { companyId, userId: { in: dto.userIds }, archivedAt: null },
        select: { userId: true },
      });
      const memberIds = memberships.map((m) => m.userId);
      if (memberIds.length === 0) return { applied: 0 };
      const res = await tx.user.updateMany({
        where: { id: { in: memberIds } },
        data: { digestOnlyNotifications: preset.digestOnly, mutedNotificationTypes: preset.mutedTypes },
      });
      return { applied: res.count };
    });
  }

  private async require(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const preset = await tx.notificationPreset.findUnique({ where: { id } });
    if (!preset || preset.companyId !== companyId) {
      throw new NotFoundException({ code: 'NOTIFICATION_PRESET_NOT_FOUND', message: 'Notification preset not found.' });
    }
    return preset;
  }
}
