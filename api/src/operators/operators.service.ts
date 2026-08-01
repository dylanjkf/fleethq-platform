import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { UsersService } from '../users/users.service';
import { ComplianceService } from '../compliance/compliance.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { ListComplianceDocumentsDto } from '../compliance/dto/list-compliance-documents.dto';
import { CreateOperatorDto } from './dto/create-operator.dto';
import { UpdateOperatorDto } from './dto/update-operator.dto';
import { LinkOperatorUserDto } from './dto/link-operator-user.dto';

@Injectable()
export class OperatorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly usersService: UsersService,
    private readonly complianceService: ComplianceService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // actorUserId is optional so the Integration Sync Engine can create rows for
  // a SCHEDULED/webhook-triggered sync (no human in the loop) via this exact
  // path — TimelineService already attributes an absent actor to SYSTEM.
  async create(companyId: string, actorUserId: string | undefined, dto: CreateOperatorDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.entitlements.assertWithinLimit(tx, companyId, 'operators');
      const operator = await tx.operator.create({
        data: {
          companyId,
          fullName: dto.fullName,
          email: dto.email,
          phone: dto.phone,
        },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.OPERATOR,
        entityId: operator.id,
        eventType: 'created',
        summary: `Operator "${operator.fullName}" created.`,
        actorUserId,
      });

      return operator;
    });
  }

  async findAll(companyId: string, query: ListQueryDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const term = query.searchTerm;
      const where: Prisma.OperatorWhereInput = {
        ...(query.includeArchived ? {} : { archivedAt: null }),
        ...(term
          ? {
              OR: [
                { fullName: { contains: term, mode: 'insensitive' } },
                { email: { contains: term, mode: 'insensitive' } },
                { phone: { contains: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        tx.operator.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: query.skip,
          take: query.take,
        }),
        tx.operator.count({ where }),
      ]);
      return { items, total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async findOne(companyId: string, id: string) {
    const operator = await this.prisma.withTenant(companyId, (tx) =>
      tx.operator.findUnique({ where: { id } }),
    );
    if (!operator || operator.companyId !== companyId) {
      throw new NotFoundException({ code: 'OPERATOR_NOT_FOUND', message: 'Operator not found.' });
    }
    return operator;
  }

  /**
   * Digital Glovebox for operator docs (licence, medical certificate) — same
   * shape and reasoning as AssetsService.getGlovebox: reuses ComplianceService's
   * existing expiry computation, gated on operators:view since it's scoped to
   * one specific operator an office user (or the operator themselves) is
   * already allowed to see.
   */
  async getGlovebox(companyId: string, operatorId: string) {
    const operator = await this.findOne(companyId, operatorId);

    const query = new ListComplianceDocumentsDto();
    query.operatorId = operatorId;
    query.pageSize = 50;
    const { items } = await this.complianceService.findAll(companyId, query);

    return {
      operator: { id: operator.id, fullName: operator.fullName },
      documents: items,
    };
  }

  /** The scanned file behind one of this operator's glovebox documents. Gated on
   *  operators:view (the same as the glovebox itself) via the controller. */
  async getGloveboxDocumentFile(companyId: string, operatorId: string, documentId: string) {
    await this.findOne(companyId, operatorId); // 404s a cross-tenant / unknown operator first.
    return this.complianceService.getDocumentFile(companyId, documentId, { operatorId });
  }

  async update(companyId: string, actorUserId: string, id: string, dto: UpdateOperatorDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireOperator(tx, companyId, id);

      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const field of ['fullName', 'email', 'phone'] as const) {
        if (dto[field] !== undefined && dto[field] !== existing[field]) {
          changed[field] = { from: existing[field], to: dto[field] };
        }
      }

      const operator = await tx.operator.update({
        where: { id },
        data: { fullName: dto.fullName, email: dto.email, phone: dto.phone },
      });

      if (Object.keys(changed).length > 0) {
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.OPERATOR,
          entityId: operator.id,
          eventType: 'updated',
          summary: `Operator "${operator.fullName}" updated.`,
          payload: changed,
          actorUserId,
        });
      }

      return operator;
    });
  }

  async archive(companyId: string, actorUserId: string, id: string) {
    const { operator, linkedUserId } = await this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireOperator(tx, companyId, id);
      if (existing.archivedAt) {
        return { operator: existing, linkedUserId: null };
      }

      const updated = await tx.operator.update({
        where: { id },
        data: { archivedAt: new Date() },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.OPERATOR,
        entityId: updated.id,
        eventType: 'archived',
        summary: `Operator "${updated.fullName}" archived.`,
        actorUserId,
      });

      return { operator: updated, linkedUserId: existing.userId };
    });

    // 01-Product/Onboarding_Decommissioning.md: archiving the profile must
    // also revoke a linked DriverOS login — a separate call (its own
    // transaction), the same pattern linkUser already uses to call
    // UsersService. A no-op if there's no linked login.
    if (linkedUserId) {
      await this.usersService.deactivateByUserId(companyId, actorUserId, linkedUserId);
    }

    return operator;
  }

  /**
   * Grants this Operator a DriverOS login (04-DriverOS/DriverOS_Overview.md):
   * creates a brand-new User + CompanyMembership + Role by delegating to
   * UsersService.create() — the exact same path inviting any other FleetHQ
   * user goes through — then links it to this Operator. `fullName` is taken
   * from the Operator itself, never re-entered ("zero duplicate data entry").
   */
  async linkUser(companyId: string, actorUserId: string, operatorId: string, dto: LinkOperatorUserDto) {
    const operator = await this.prisma.withTenant(companyId, (tx) =>
      tx.operator.findUnique({ where: { id: operatorId } }),
    );
    if (!operator || operator.companyId !== companyId) {
      throw new NotFoundException({ code: 'OPERATOR_NOT_FOUND', message: 'Operator not found.' });
    }
    if (operator.archivedAt) {
      throw new ConflictException({
        code: 'OPERATOR_ARCHIVED',
        message: 'Cannot grant a login to an archived operator.',
      });
    }
    if (operator.userId) {
      throw new ConflictException({
        code: 'OPERATOR_ALREADY_LINKED',
        message: 'This operator already has a DriverOS login.',
      });
    }

    const membership = await this.usersService.create(companyId, actorUserId, {
      username: dto.username,
      password: dto.password,
      fullName: operator.fullName,
      roleId: dto.roleId,
    });

    return this.prisma.withTenant(companyId, async (tx) => {
      const updated = await tx.operator.update({
        where: { id: operatorId },
        data: { userId: membership.userId },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.OPERATOR,
        entityId: operatorId,
        eventType: 'login_linked',
        summary: `Operator "${operator.fullName}" granted a DriverOS login ("${dto.username}").`,
        actorUserId,
      });

      return updated;
    });
  }

  async requireOperator(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const operator = await tx.operator.findUnique({ where: { id } });
    if (!operator || operator.companyId !== companyId) {
      throw new NotFoundException({ code: 'OPERATOR_NOT_FOUND', message: 'Operator not found.' });
    }
    return operator;
  }
}
