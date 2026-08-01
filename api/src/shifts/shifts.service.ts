import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, ShiftStatus, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { FatigueService } from '../compliance/fatigue.service';
import { ListShiftsDto } from './dto/list-shifts.dto';
import { ShiftSummaryDto } from './dto/shift-summary.dto';

/**
 * Operator shift start/end (courier vertical, 00-Company/Commercial_Priority.md):
 * a plain clock-in/clock-out so the office can see who was working when,
 * plus a day summary rolling shifts up per operator. No timesheet/payroll
 * export, break tracking, or geofencing — just start/end and a duration.
 */
@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly fatigue: FatigueService,
  ) {}

  async start(companyId: string, actorUserId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const operator = await this.requireCallerOperator(tx, actorUserId);
      const active = await tx.operatorShift.findFirst({ where: { operatorId: operator.id, status: ShiftStatus.ACTIVE } });
      if (active) {
        throw new ConflictException({ code: 'SHIFT_ALREADY_ACTIVE', message: 'A shift is already active.' });
      }
      const shift = await tx.operatorShift.create({ data: { companyId, operatorId: operator.id } });
      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.OPERATOR,
        entityId: operator.id,
        eventType: 'shift_started',
        summary: `${operator.fullName} started a shift.`,
        actorUserId,
      });
      return shift;
    });
  }

  async end(companyId: string, actorUserId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const operator = await this.requireCallerOperator(tx, actorUserId);
      const active = await tx.operatorShift.findFirst({ where: { operatorId: operator.id, status: ShiftStatus.ACTIVE } });
      if (!active) {
        throw new ConflictException({ code: 'SHIFT_NOT_ACTIVE', message: 'There is no active shift to end.' });
      }
      const shift = await tx.operatorShift.update({
        where: { id: active.id },
        data: { status: ShiftStatus.ENDED, endedAt: new Date() },
      });
      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.OPERATOR,
        entityId: operator.id,
        eventType: 'shift_ended',
        summary: `${operator.fullName} ended their shift.`,
        actorUserId,
      });
      // 08-Compliance/Australian_Compliance.md: "every fatigue-rule check
      // produces a Timeline event" — checked here, at shift end, rather than
      // continuously, since that's the one discrete moment a completed
      // shift's own hours are final.
      await this.fatigue.recordBreachOnShiftEnd(tx, companyId, operator.id);
      return shift;
    });
  }

  async current(companyId: string, actorUserId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const operator = await tx.operator.findFirst({ where: { userId: actorUserId, archivedAt: null } });
      if (!operator) return { shift: null };
      const shift = await tx.operatorShift.findFirst({ where: { operatorId: operator.id, status: ShiftStatus.ACTIVE } });
      return { shift };
    });
  }

  async findAll(companyId: string, query: ListShiftsDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const where: Prisma.OperatorShiftWhereInput = {};
      if (query.operatorId) where.operatorId = query.operatorId;
      if (query.from || query.to) {
        where.startedAt = {
          ...(query.from ? { gte: startOfDay(new Date(query.from)) } : {}),
          ...(query.to ? { lte: endOfDay(new Date(query.to)) } : {}),
        };
      }
      const [items, total] = await Promise.all([
        tx.operatorShift.findMany({
          where,
          include: { operator: { select: { id: true, fullName: true } } },
          orderBy: { startedAt: 'desc' },
          skip: query.skip,
          take: query.take,
        }),
        tx.operatorShift.count({ where }),
      ]);
      return { items, total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async summary(companyId: string, query: ShiftSummaryDto) {
    const day = query.date ? new Date(query.date) : new Date();
    const from = startOfDay(day);
    const to = endOfDay(day);

    return this.prisma.withTenant(companyId, async (tx) => {
      const shifts = await tx.operatorShift.findMany({
        where: { startedAt: { lte: to }, OR: [{ endedAt: null }, { endedAt: { gte: from } }] },
        include: { operator: { select: { id: true, fullName: true } } },
        orderBy: { startedAt: 'asc' },
      });

      const now = new Date();
      const byOperator = new Map<
        string,
        { operatorId: string; name: string; totalMinutes: number; shifts: { id: string; startedAt: Date; endedAt: Date | null; status: ShiftStatus; minutes: number }[] }
      >();
      for (const shift of shifts) {
        const windowStart = shift.startedAt > from ? shift.startedAt : from;
        const windowEndRaw = shift.endedAt ?? now;
        const windowEnd = windowEndRaw < to ? windowEndRaw : to;
        const minutes = Math.max(0, Math.round((windowEnd.getTime() - windowStart.getTime()) / 60000));

        const key = shift.operatorId;
        if (!byOperator.has(key)) {
          byOperator.set(key, { operatorId: key, name: shift.operator.fullName, totalMinutes: 0, shifts: [] });
        }
        const row = byOperator.get(key)!;
        row.totalMinutes += minutes;
        row.shifts.push({ id: shift.id, startedAt: shift.startedAt, endedAt: shift.endedAt, status: shift.status, minutes });
      }

      return {
        date: from,
        operators: [...byOperator.values()].sort((a, b) => b.totalMinutes - a.totalMinutes),
      };
    });
  }

  private async requireCallerOperator(tx: Prisma.TransactionClient, actorUserId: string) {
    const operator = await tx.operator.findFirst({ where: { userId: actorUserId, archivedAt: null } });
    if (!operator) {
      throw new ConflictException({ code: 'SHIFT_OPERATOR_REQUIRED', message: 'Only a linked Operator login can start or end a shift.' });
    }
    return operator;
  }
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}
function endOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(23, 59, 59, 999);
  return c;
}
