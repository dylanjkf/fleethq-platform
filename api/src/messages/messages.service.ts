import { BadRequestException, Injectable } from '@nestjs/common';
import { MessageSenderType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OperatorsService } from '../operators/operators.service';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { SendMessageDto } from './dto/send-message.dto';
import { BroadcastMessageDto } from './dto/broadcast-message.dto';
import { ListMessagesDto } from './dto/list-messages.dto';

/** Most-recent messages returned per thread — keeps the read bounded on a hot table. */
const MESSAGE_THREAD_LIMIT = 200;

/**
 * DriverOS messaging v0 (04-DriverOS/DriverOS_Overview.md): a single
 * operator ↔ office thread per Operator. Deliberately scoped — no attachments,
 * read receipts, group threads, or push notifications. An operator can only
 * ever read/write their own thread (the server pins it from the JWT's linked
 * Operator, never trusting a client-supplied operatorId); an office user
 * addresses any operator by id.
 */
@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly operators: OperatorsService,
  ) {}

  async list(companyId: string, actorUserId: string, query: ListMessagesDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const operatorId = await this.resolveThreadOperatorId(tx, companyId, actorUserId, query.operatorId);
      // A chat thread grows without bound over months, so the read is always
      // bounded to one page. `page` 1 is the most recent window (default 200,
      // the shared row cap); `page` > 1 walks progressively older history.
      // Results are returned oldest-first within the page, matching the display.
      const pageSize = query.take ?? MESSAGE_THREAD_LIMIT;
      const skip = query.skip ?? 0;
      const [recent, total] = await Promise.all([
        tx.message.findMany({
          where: { operatorId },
          include: { senderUser: { select: { id: true, fullName: true } } },
          orderBy: { createdAt: 'desc' },
          skip,
          take: pageSize,
        }),
        tx.message.count({ where: { operatorId } }),
      ]);
      return { operatorId, items: recent.reverse(), total, page: query.page ?? 1, pageSize };
    });
  }

  async send(companyId: string, actorUserId: string, dto: SendMessageDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      // Idempotent replay: a DriverOS message queued offline and re-sent after a
      // lost response carries a stable clientRequestId — return the existing
      // message rather than double-posting to the office.
      if (dto.clientRequestId) {
        const existing = await tx.message.findFirst({
          where: { companyId, clientRequestId: dto.clientRequestId },
          include: { senderUser: { select: { id: true, fullName: true } } },
        });
        if (existing) return existing;
      }

      const ownOperator = await this.callerOperator(tx, actorUserId);
      let operatorId: string;
      let senderType: MessageSenderType;

      if (ownOperator) {
        // The caller is an operator — their message goes in their own thread.
        operatorId = ownOperator.id;
        senderType = MessageSenderType.OPERATOR;
      } else {
        // Office user — must address a specific operator's thread.
        if (!dto.operatorId) {
          throw new BadRequestException({
            code: 'MESSAGE_OPERATOR_REQUIRED',
            message: 'An operator must be specified to send a message.',
          });
        }
        await this.operators.requireOperator(tx, companyId, dto.operatorId, { allowArchived: false });
        operatorId = dto.operatorId;
        senderType = MessageSenderType.OFFICE;
      }

      const message = await tx.message.create({
        data: { companyId, operatorId, senderType, senderUserId: actorUserId, body: dto.body, clientRequestId: dto.clientRequestId ?? null },
        include: { senderUser: { select: { id: true, fullName: true } } },
      });

      const preview = dto.body.length > 80 ? `${dto.body.slice(0, 77)}…` : dto.body;
      if (senderType === MessageSenderType.OPERATOR) {
        // Operator → office: ping everyone who watches Dispatch.
        await this.notifications.notifyPermissionInTx(
          tx,
          companyId,
          PERMISSIONS.DISPATCH_VIEW,
          { type: 'message', title: `New message from ${ownOperator?.fullName ?? 'an operator'}`, body: preview, linkPath: '/messages' },
          actorUserId,
        );
      } else {
        // Office → operator: ping the operator's DriverOS login, if linked.
        const operator = await tx.operator.findUnique({ where: { id: operatorId }, select: { userId: true } });
        if (operator?.userId) {
          await this.notifications.notifyUserInTx(tx, companyId, operator.userId, {
            type: 'message',
            title: 'New message from the office',
            body: preview,
            linkPath: '/messages',
          });
        }
      }

      return message;
    });
  }

  /**
   * Send one office message into every active operator's thread at once. A
   * broadcast is just N ordinary OFFICE messages — each driver sees it as a
   * normal message in their own thread — so nothing about DriverOS changes.
   */
  async broadcast(companyId: string, actorUserId: string, dto: BroadcastMessageDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const operators = await tx.operator.findMany({
        where: { archivedAt: null },
        select: { id: true, userId: true },
      });
      if (operators.length === 0) {
        throw new BadRequestException({
          code: 'NO_OPERATORS',
          message: 'There are no operators to message.',
        });
      }

      await tx.message.createMany({
        data: operators.map((op) => ({
          companyId,
          operatorId: op.id,
          senderType: MessageSenderType.OFFICE,
          senderUserId: actorUserId,
          body: dto.body,
        })),
      });

      // Ping each operator's DriverOS login (those that have one).
      const preview = dto.body.length > 80 ? `${dto.body.slice(0, 77)}…` : dto.body;
      for (const op of operators) {
        if (op.userId) {
          await this.notifications.notifyUserInTx(tx, companyId, op.userId, {
            type: 'message',
            title: 'New message from the office',
            body: preview,
            linkPath: '/messages',
          });
        }
      }

      return { sent: operators.length };
    });
  }

  private async resolveThreadOperatorId(
    tx: Prisma.TransactionClient,
    companyId: string,
    actorUserId: string,
    requestedOperatorId?: string,
  ): Promise<string> {
    const ownOperator = await this.callerOperator(tx, actorUserId);
    if (ownOperator) return ownOperator.id;
    if (!requestedOperatorId) {
      throw new BadRequestException({
        code: 'MESSAGE_OPERATOR_REQUIRED',
        message: 'An operator must be specified to view a thread.',
      });
    }
    await this.operators.requireOperator(tx, companyId, requestedOperatorId, { allowArchived: false });
    return requestedOperatorId;
  }

  private async callerOperator(tx: Prisma.TransactionClient, actorUserId: string) {
    return tx.operator.findFirst({ where: { userId: actorUserId, archivedAt: null } });
  }
}
