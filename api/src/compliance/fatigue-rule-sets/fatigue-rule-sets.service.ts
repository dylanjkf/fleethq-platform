import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AU_STANDARD_HOURS_DEFAULTS } from '../jurisdiction/au-fatigue-rules';
import { CreateFatigueRuleSetDto, DeployFatigueRuleSetDto, UpdateFatigueRuleSetDto } from './dto/fatigue-rule-set.dto';

/**
 * CRUD + deploy for customer-saved fatigue rule sets — the "savable layout"
 * for fatigue thresholds. A set can be created (optionally from the built-in
 * AU Standard Hours preset), edited, made the company default, and deployed to
 * any number of operators in one action. The FatigueService reads these when
 * evaluating an operator; nothing here touches the evaluation maths.
 */
@Injectable()
export class FatigueRuleSetsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The built-in AU Standard Hours numbers, offered as a starting preset. */
  preset() {
    const d = AU_STANDARD_HOURS_DEFAULTS;
    return {
      name: 'AU Standard Hours (solo driver)',
      maxWork24hMin: d.maxWork24hMin,
      minRest24hMin: d.minRest24hMin,
      maxWork7dMin: d.maxWork7dMin,
      minRest7dMin: d.minRest7dMin,
      approachingBufferMin: d.approachingBufferMin,
      lookbackDays: d.lookbackDays,
    };
  }

  async findAll(companyId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const items = await tx.fatigueRuleSet.findMany({
        where: { archivedAt: null },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        include: { _count: { select: { operators: { where: { archivedAt: null } } } } },
      });
      return { items };
    });
  }

  async create(companyId: string, dto: CreateFatigueRuleSetDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      if (dto.isDefault) await this.clearDefault(tx);
      return tx.fatigueRuleSet.create({
        data: {
          companyId,
          name: dto.name.trim(),
          isDefault: dto.isDefault ?? false,
          maxWork24hMin: dto.maxWork24hMin,
          minRest24hMin: dto.minRest24hMin,
          maxWork7dMin: dto.maxWork7dMin,
          minRest7dMin: dto.minRest7dMin,
          approachingBufferMin: dto.approachingBufferMin,
          lookbackDays: dto.lookbackDays ?? 8,
        },
      });
    });
  }

  async update(companyId: string, id: string, dto: UpdateFatigueRuleSetDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.require(tx, companyId, id);
      if (dto.isDefault) await this.clearDefault(tx, id);
      return tx.fatigueRuleSet.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          isDefault: dto.isDefault,
          maxWork24hMin: dto.maxWork24hMin,
          minRest24hMin: dto.minRest24hMin,
          maxWork7dMin: dto.maxWork7dMin,
          minRest7dMin: dto.minRest7dMin,
          approachingBufferMin: dto.approachingBufferMin,
          lookbackDays: dto.lookbackDays,
        },
      });
    });
  }

  async archive(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const set = await this.require(tx, companyId, id);
      if (set.archivedAt) return set;
      // Operators pointing at it fall back to the default automatically (the
      // FK is nullable and resolution handles a missing/archived set).
      return tx.fatigueRuleSet.update({ where: { id }, data: { archivedAt: new Date(), isDefault: false } });
    });
  }

  /** Deploy: assign the set to the given operators and/or make it the default. */
  async deploy(companyId: string, id: string, dto: DeployFatigueRuleSetDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.require(tx, companyId, id);
      let assigned = 0;
      if (dto.operatorIds?.length) {
        const res = await tx.operator.updateMany({
          where: { id: { in: dto.operatorIds }, companyId, archivedAt: null },
          data: { fatigueRuleSetId: id },
        });
        assigned = res.count;
      }
      if (dto.setDefault) {
        await this.clearDefault(tx, id);
        await tx.fatigueRuleSet.update({ where: { id }, data: { isDefault: true } });
      }
      return { assigned, setDefault: !!dto.setDefault };
    });
  }

  private async clearDefault(tx: Prisma.TransactionClient, exceptId?: string) {
    await tx.fatigueRuleSet.updateMany({
      where: { isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
      data: { isDefault: false },
    });
  }

  private async require(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const set = await tx.fatigueRuleSet.findUnique({ where: { id } });
    if (!set || set.companyId !== companyId) {
      throw new NotFoundException({ code: 'FATIGUE_RULE_SET_NOT_FOUND', message: 'Fatigue rule set not found.' });
    }
    return set;
  }
}
