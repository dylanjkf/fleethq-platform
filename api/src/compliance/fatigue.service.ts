import { Injectable } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { getFatigueRuleSet } from './jurisdiction/jurisdiction-registry';
import { createStandardHoursRuleSet } from './jurisdiction/au-fatigue-rules';
import type { FatigueRuleFlag, FatigueRuleSet, FatigueStatus } from './jurisdiction/fatigue-rule-set.interface';

export interface OperatorFatigueStatus {
  operatorId: string;
  operatorName: string;
  status: FatigueStatus | 'not_assessed';
  ruleSetName: string | null;
  breaches: FatigueRuleFlag[];
  approaching: FatigueRuleFlag[];
  workMinutesLast24h: number;
  longestRestMinutesLast24h: number;
  workMinutesLast7d: number;
  longestRestMinutesLast7d: number;
}

/**
 * 01-Product/Australian_Compliance.md's fatigue management line, built now
 * that its own stated blocker is gone: OperatorShift (start/end timestamps)
 * shipped in the Dispatch milestone, so a real work/rest-hours clock exists
 * to evaluate rules against. This service is deliberately jurisdiction-blind
 * — see 08-Compliance/Jurisdiction_Model.md — it only ever calls into
 * whatever `FatigueRuleSet` the company's own `jurisdiction` resolves to via
 * the registry; it contains no AU-specific hour limit itself.
 */
@Injectable()
export class FatigueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
  ) {}

  async getStatusForOperator(companyId: string, operatorId: string): Promise<OperatorFatigueStatus> {
    return this.prisma.withTenant(companyId, (tx) => this.evaluateOperator(tx, companyId, operatorId, new Date()));
  }

  /** Every operator with at least one shift in the lookback window, filtered to non-`ok`/non-`not_assessed` — the Compliance dashboard's "operators approaching fatigue limits" list. */
  async getAtRiskOperators(companyId: string): Promise<OperatorFatigueStatus[]> {
    return this.prisma.withTenant(companyId, async (tx) => {
      const now = new Date();
      const ruleSet = await this.resolveDefaultRuleSet(tx, companyId);
      if (!ruleSet) return [];

      const lookbackStart = new Date(now.getTime() - ruleSet.lookbackDays * 24 * 60 * 60 * 1000);
      const recentOperatorIds = await tx.operatorShift.findMany({
        where: { companyId, startedAt: { gte: lookbackStart } },
        distinct: ['operatorId'],
        select: { operatorId: true },
      });

      const statuses = await Promise.all(
        recentOperatorIds.map((row) => this.evaluateOperator(tx, companyId, row.operatorId, now)),
      );
      return statuses.filter((s) => s.status === 'breach' || s.status === 'approaching_limit');
    });
  }

  /**
   * Called from within `ShiftsService.end()`'s own transaction — a breach
   * detected the moment a shift ends becomes a Timeline event on the
   * Operator, the "audit trail as a byproduct of normal use" this doc
   * requires. Approaching-limit is deliberately not logged here (it isn't a
   * breach yet, and would just be noise on every shift end); it only ever
   * surfaces live via the dashboard/status endpoints.
   */
  async recordBreachOnShiftEnd(tx: Prisma.TransactionClient, companyId: string, operatorId: string): Promise<void> {
    const status = await this.evaluateOperator(tx, companyId, operatorId, new Date());
    if (status.status !== 'breach') return;
    await this.timeline.record(tx, {
      companyId,
      entityType: TimelineEntityType.OPERATOR,
      entityId: operatorId,
      eventType: 'fatigue_breach',
      summary: `${status.operatorName} breached ${status.breaches.length === 1 ? 'a Standard Hours rule' : 'multiple Standard Hours rules'} (${status.ruleSetName}).`,
      payload: { breaches: status.breaches },
    });
  }

  /**
   * Called from within `JobsService.assign()`'s own transaction when a
   * dispatcher proceeds with `acknowledgeFatigueRisk: true` despite a
   * flagged risk — 08-Compliance/Australian_Compliance.md's edge case:
   * permitted, but "logged clearly as an overridden warning, never
   * indistinguishable from a compliant state."
   */
  async recordOverride(
    tx: Prisma.TransactionClient,
    companyId: string,
    operatorId: string,
    jobId: string,
    actorUserId: string,
    status: OperatorFatigueStatus,
  ): Promise<void> {
    await this.timeline.record(tx, {
      companyId,
      entityType: TimelineEntityType.OPERATOR,
      entityId: operatorId,
      eventType: 'fatigue_risk_overridden',
      summary: `${status.operatorName} was assigned a job despite a flagged fatigue risk (overridden by dispatcher).`,
      payload: {
        jobId,
        status: status.status,
        breaches: status.breaches,
        approaching: status.approaching,
      },
      actorUserId,
    });
  }

  /**
   * The company-wide default rule set: a saved custom set marked default if one
   * exists, otherwise the built-in jurisdiction rule set. Used to decide which
   * operators are even candidates for the at-risk list.
   */
  private async resolveDefaultRuleSet(tx: Prisma.TransactionClient, companyId: string): Promise<FatigueRuleSet | null> {
    const custom = await tx.fatigueRuleSet.findFirst({ where: { companyId, isDefault: true, archivedAt: null } });
    if (custom) return this.buildRuleSet(custom);
    const company = await tx.company.findUnique({ where: { id: companyId }, select: { jurisdiction: true } });
    return getFatigueRuleSet(company?.jurisdiction ?? '');
  }

  /**
   * The rule set that applies to a specific operator: their explicitly-deployed
   * set → the company default → the built-in jurisdiction default.
   */
  private async resolveRuleSetForOperator(
    tx: Prisma.TransactionClient,
    companyId: string,
    operator: { fatigueRuleSetId: string | null },
  ): Promise<FatigueRuleSet | null> {
    if (operator.fatigueRuleSetId) {
      const assigned = await tx.fatigueRuleSet.findFirst({ where: { id: operator.fatigueRuleSetId, archivedAt: null } });
      if (assigned) return this.buildRuleSet(assigned);
    }
    return this.resolveDefaultRuleSet(tx, companyId);
  }

  private buildRuleSet(row: {
    name: string;
    maxWork24hMin: number;
    minRest24hMin: number;
    maxWork7dMin: number;
    minRest7dMin: number;
    approachingBufferMin: number;
    lookbackDays: number;
  }): FatigueRuleSet {
    return createStandardHoursRuleSet({
      name: row.name,
      jurisdiction: 'CUSTOM',
      maxWork24hMin: row.maxWork24hMin,
      minRest24hMin: row.minRest24hMin,
      maxWork7dMin: row.maxWork7dMin,
      minRest7dMin: row.minRest7dMin,
      approachingBufferMin: row.approachingBufferMin,
      lookbackDays: row.lookbackDays,
    });
  }

  private async evaluateOperator(
    tx: Prisma.TransactionClient,
    companyId: string,
    operatorId: string,
    now: Date,
  ): Promise<OperatorFatigueStatus> {
    const operator = await tx.operator.findUnique({ where: { id: operatorId }, select: { fullName: true, fatigueRuleSetId: true } });
    const operatorName = operator?.fullName ?? 'Unknown operator';

    const ruleSet = await this.resolveRuleSetForOperator(tx, companyId, { fatigueRuleSetId: operator?.fatigueRuleSetId ?? null });
    if (!ruleSet) {
      return {
        operatorId,
        operatorName,
        status: 'not_assessed',
        ruleSetName: null,
        breaches: [],
        approaching: [],
        workMinutesLast24h: 0,
        longestRestMinutesLast24h: 0,
        workMinutesLast7d: 0,
        longestRestMinutesLast7d: 0,
      };
    }

    const lookbackStart = new Date(now.getTime() - ruleSet.lookbackDays * 24 * 60 * 60 * 1000);
    const shifts = await tx.operatorShift.findMany({
      where: { operatorId, OR: [{ endedAt: null }, { endedAt: { gte: lookbackStart } }] },
      orderBy: { startedAt: 'asc' },
    });

    const result = ruleSet.evaluate({
      shifts: shifts.map((s) => ({ startedAt: s.startedAt, endedAt: s.endedAt ?? now })),
      now,
    });

    return { operatorId, operatorName, ruleSetName: ruleSet.name, ...result };
  }
}
