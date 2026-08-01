import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionKey } from '../common/permissions/permission-catalog';
import { NOTIFICATION_CHANNEL, type NotificationChannel } from './channels/notification-channel';
import { PushService } from './push/push.service';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { MAX_AGGREGATION_ROWS } from '../common/query/row-caps';

export interface NotificationInput {
  type: string;
  title: string;
  body?: string;
  linkPath?: string;
}

/**
 * In-app notifications (cross-cutting v0). The `*InTx` methods are called by
 * other services from inside their own `withTenant` transaction so a
 * notification commits atomically with the event that raised it (a failed
 * delivery, a message, an auto-raised fault, a new assignment). Everything is
 * per-recipient; "notify the office" fans out to every user who holds a given
 * permission.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_CHANNEL) private readonly channel: NotificationChannel,
    private readonly push: PushService,
  ) {}

  /** Create one notification for a specific user, inside the caller's transaction. */
  async notifyUserInTx(
    tx: Prisma.TransactionClient,
    companyId: string,
    recipientUserId: string,
    input: NotificationInput,
  ): Promise<void> {
    const recipient = await tx.user.findUnique({
      where: { id: recipientUserId },
      select: { mutedNotificationTypes: true },
    });
    if (recipient?.mutedNotificationTypes.includes(input.type)) return;

    await tx.notification.create({
      data: { companyId, recipientUserId, type: input.type, title: input.title, body: input.body, linkPath: input.linkPath },
    });
    // Fire-and-forget: see PushService.notifyUser's doc comment for why this
    // is never awaited inside the caller's own transaction.
    this.push.notifyUser(recipientUserId, { title: input.title, body: input.body, linkPath: input.linkPath });
  }

  /**
   * Fan a notification out to every user in the company whose active role grants
   * `permissionKey` (e.g. everyone who can see Dispatch), optionally excluding the
   * actor who caused the event so they aren't pinged about their own action.
   */
  async notifyPermissionInTx(
    tx: Prisma.TransactionClient,
    companyId: string,
    permissionKey: PermissionKey,
    input: NotificationInput,
    exceptUserId?: string,
  ): Promise<void> {
    const memberships = await tx.companyMembership.findMany({
      where: {
        archivedAt: null,
        role: { archivedAt: null, permissions: { some: { permission: { key: permissionKey } } } },
      },
      select: { userId: true },
    });
    const candidates = [...new Set(memberships.map((m) => m.userId))].filter((id) => id !== exceptUserId);
    if (candidates.length === 0) return;

    const candidateUsers = await tx.user.findMany({
      where: { id: { in: candidates } },
      select: { id: true, mutedNotificationTypes: true },
    });
    const recipients = candidateUsers
      .filter((u) => !u.mutedNotificationTypes.includes(input.type))
      .map((u) => u.id);
    if (recipients.length === 0) return;
    await tx.notification.createMany({
      data: recipients.map((recipientUserId) => ({
        companyId,
        recipientUserId,
        type: input.type,
        title: input.title,
        body: input.body,
        linkPath: input.linkPath,
      })),
    });
    for (const recipientUserId of recipients) {
      this.push.notifyUser(recipientUserId, { title: input.title, body: input.body, linkPath: input.linkPath });
    }
  }

  /**
   * The users a `notifyPermissionInTx` call for the same `permissionKey` would
   * reach, with the profile fields a caller needs to also send a companion
   * email (`fullName`/`email`) — kept as a separate query rather than having
   * `notifyPermissionInTx` return this itself, so a caller that only wants
   * the in-app fan-out (the common case) doesn't pay for `fullName`/`email`
   * it never uses. Relies on `tx` already being tenant-scoped (via
   * `PrismaService.withTenant`) rather than filtering on companyId itself,
   * matching `notifyPermissionInTx`'s own membership query.
   */
  async getPermissionHolders(
    tx: Prisma.TransactionClient,
    permissionKey: PermissionKey,
  ): Promise<{ id: string; fullName: string; email: string | null }[]> {
    const memberships = await tx.companyMembership.findMany({
      where: { archivedAt: null, role: { archivedAt: null, permissions: { some: { permission: { key: permissionKey } } } } },
      select: { userId: true },
    });
    const userIds = [...new Set(memberships.map((m) => m.userId))];
    if (userIds.length === 0) return [];
    return tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, email: true } });
  }

  async listForUser(companyId: string, userId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const [items, unreadCount, user] = await Promise.all([
        tx.notification.findMany({
          where: { recipientUserId: userId },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        tx.notification.count({ where: { recipientUserId: userId, readAt: null } }),
        tx.user.findUnique({ where: { id: userId }, select: { digestOnlyNotifications: true } }),
      ]);
      // Alert-fatigue control: a digest-only user's items are still listed
      // (and still feed the digest), they just don't nag a live unread badge.
      return { items, unreadCount: user?.digestOnlyNotifications ? 0 : unreadCount };
    });
  }

  async getPreferences(companyId: string, userId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { digestOnlyNotifications: true, mutedNotificationTypes: true },
      });
      return { digestOnly: user.digestOnlyNotifications, mutedTypes: user.mutedNotificationTypes };
    });
  }

  async updatePreferences(companyId: string, userId: string, dto: UpdateNotificationPreferencesDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: {
          ...(dto.digestOnly !== undefined ? { digestOnlyNotifications: dto.digestOnly } : {}),
          ...(dto.mutedTypes !== undefined ? { mutedNotificationTypes: dto.mutedTypes } : {}),
        },
        select: { digestOnlyNotifications: true, mutedNotificationTypes: true },
      });
      return { digestOnly: user.digestOnlyNotifications, mutedTypes: user.mutedNotificationTypes };
    });
  }

  async markRead(companyId: string, userId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await tx.notification.findUnique({ where: { id } });
      if (!existing || existing.companyId !== companyId || existing.recipientUserId !== userId) {
        throw new NotFoundException({ code: 'NOTIFICATION_NOT_FOUND', message: 'Notification not found.' });
      }
      if (existing.readAt) return existing;
      return tx.notification.update({ where: { id }, data: { readAt: new Date() } });
    });
  }

  async markAllRead(companyId: string, userId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const result = await tx.notification.updateMany({
        where: { recipientUserId: userId, readAt: null },
        data: { readAt: new Date() },
      });
      return { updated: result.count };
    });
  }

  /**
   * Email digest channel v0 (Notification.emailedAt's doc comment): there's no
   * real SMTP/email provider wired up yet, so "sending" means computing what
   * each recipient's digest would contain and marking those notifications
   * `emailedAt` so a later run (or a real provider, once one exists) never
   * double-sends them — the same "simulate the infra now, swap it in later"
   * precedent as Attachments storing bytes in Postgres.
   */
  async previewDigest(companyId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const { notificationIds: _notificationIds, ...result } = await this.computeDigest(tx);
      return result;
    });
  }

  async sendDigest(companyId: string) {
    const digest = await this.prisma.withTenant(companyId, async (tx) => {
      const computed = await this.computeDigest(tx);
      if (computed.notificationIds.length > 0) {
        await tx.notification.updateMany({ where: { id: { in: computed.notificationIds } }, data: { emailedAt: new Date() } });
      }
      return computed;
    });

    // Sent after the transaction commits — a channel failure (or, once a
    // real provider exists, a slow one) should never roll back the
    // `emailedAt` marks that make this idempotent. Only recipients with a real
    // email address are contactable; `username` is a login handle, not an
    // inbox, so a recipient without an email is simply skipped (their in-app +
    // push notifications still landed).
    for (const recipient of digest.recipients) {
      if (!recipient.email) continue;
      await this.channel.sendEmail({
        to: recipient.email,
        subject: `FleetOS: ${recipient.itemCount} new notification${recipient.itemCount === 1 ? '' : 's'}`,
        body: recipient.subjects.join('\n'),
      });
    }

    const { notificationIds: _notificationIds, ...result } = digest;
    return result;
  }

  private async computeDigest(tx: Prisma.TransactionClient) {
    // Bounded read of the un-emailed backlog: sendDigest marks these emailed,
    // so a subsequent run picks up anything past this cap — the digest just
    // drains a very large backlog over a few runs rather than loading it all at
    // once. previewDigest never marks, but only ever needs a representative page.
    const pending = await tx.notification.findMany({
      where: { emailedAt: null, readAt: null },
      orderBy: { createdAt: 'asc' },
      take: MAX_AGGREGATION_ROWS,
    });

    const byRecipient = new Map<string, typeof pending>();
    for (const n of pending) {
      const list = byRecipient.get(n.recipientUserId) ?? [];
      list.push(n);
      byRecipient.set(n.recipientUserId, list);
    }

    const users = await tx.user.findMany({
      where: { id: { in: [...byRecipient.keys()] } },
      select: { id: true, username: true, fullName: true, email: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    const recipients = [...byRecipient.entries()].map(([userId, items]) => ({
      userId,
      username: userById.get(userId)?.username ?? 'unknown',
      email: userById.get(userId)?.email ?? null,
      fullName: userById.get(userId)?.fullName ?? 'Unknown user',
      itemCount: items.length,
      subjects: items.slice(0, 5).map((i) => i.title),
    }));

    // `recipientCount` is who will actually be emailed — recipients without an
    // email address are skipped in the send loop, so counting them here would
    // make "sent to N people" a lie. `skippedCount` surfaces them honestly so
    // the office knows someone's notifications only landed in-app.
    const emailableCount = recipients.filter((r) => r.email).length;
    return {
      recipientCount: emailableCount,
      skippedCount: recipients.length - emailableCount,
      recipients,
      notificationIds: pending.map((n) => n.id),
    };
  }
}
