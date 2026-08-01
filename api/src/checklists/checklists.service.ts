import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { CreateChecklistTemplateDto } from './dto/create-checklist-template.dto';
import { UpdateChecklistTemplateDto } from './dto/update-checklist-template.dto';
import { ListChecklistTemplatesDto } from './dto/list-checklist-templates.dto';
import { SubmitChecklistDto } from './dto/submit-checklist.dto';
import { ListChecklistSubmissionsDto } from './dto/list-checklist-submissions.dto';
import { ChecklistItemDto } from './dto/checklist-item.dto';
import { MAX_AGGREGATION_ROWS } from '../common/query/row-caps';

/** The normalized item shape persisted in `items` / `template_snapshot` JSON. */
interface NormalizedItem {
  id: string;
  label: string;
  type: 'pass_fail' | 'pass_fail_na' | 'text';
  requireNoteOnFail: boolean;
  createsFaultOnFail: boolean;
}

/**
 * The Smart Checklists milestone's scoped slice (01-Product/Smart_Checklists.md):
 * company-configurable, versioned pre-start templates plus immutable operator
 * submissions that run fully offline on DriverOS. The only "branching" is two
 * data-driven booleans per item — a failed item can require a note and/or spawn
 * a workshop MaintenanceJob. No conditional question trees, photo/measurement
 * capture, or scheduling — see the doc's implementation notes for the reasoning.
 */
@Injectable()
export class ChecklistsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---- Templates (office-managed, FleetHQ) --------------------------------

  async createTemplate(companyId: string, actorUserId: string, dto: CreateChecklistTemplateDto) {
    const items = this.normalizeItems(dto.items);
    return this.prisma.withTenant(companyId, async (tx) => {
      const appliesToAssetClassId = await this.resolveAssetClassId(tx, dto.appliesToAssetClass);

      const template = await tx.checklistTemplate.create({
        data: {
          companyId,
          name: dto.name,
          appliesToAssetClassId,
          items: items as unknown as Prisma.InputJsonValue,
        },
        include: { appliesToAssetClass: true },
      });

      await this.syncAssignments(tx, companyId, template.id, dto.assignedAssetIds ?? []);

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.CHECKLIST_TEMPLATE,
        entityId: template.id,
        eventType: 'created',
        summary: `Checklist template "${template.name}" created.`,
        actorUserId,
      });

      return this.templateWithAssignments(tx, template.id);
    });
  }

  async findAllTemplates(companyId: string, query: ListChecklistTemplatesDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      // DriverOS asks "which checklist applies to the asset I'm on"; the office
      // asks for the whole library. When an asset is named we resolve its class
      // and return class-specific plus class-agnostic (null) templates.
      let assetClassFilter: Prisma.ChecklistTemplateWhereInput = {};
      if (query.assetId) {
        const asset = await this.requireAsset(tx, companyId, query.assetId);
        // Applicable = matches the asset's class, is class-agnostic (null), OR is
        // directly assigned to this asset (the persistent per-asset assignment).
        assetClassFilter = {
          OR: [
            { appliesToAssetClassId: asset.assetClassId },
            { appliesToAssetClassId: null },
            { assignments: { some: { assetId: asset.id } } },
          ],
        };
      } else if (query.assetClass) {
        const assetClassId = await this.resolveAssetClassId(tx, query.assetClass);
        assetClassFilter = {
          OR: [{ appliesToAssetClassId: assetClassId }, { appliesToAssetClassId: null }],
        };
      }

      const where: Prisma.ChecklistTemplateWhereInput = {
        ...(query.includeArchived ? {} : { archivedAt: null }),
        ...assetClassFilter,
      };
      const [items, total] = await Promise.all([
        tx.checklistTemplate.findMany({
          where,
          include: { appliesToAssetClass: true, assignments: { select: { assetId: true } } },
          orderBy: { name: 'asc' },
          skip: query.skip,
          take: query.take,
        }),
        tx.checklistTemplate.count({ where }),
      ]);
      return { items, total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async findOneTemplate(companyId: string, id: string) {
    const template = await this.prisma.withTenant(companyId, (tx) =>
      tx.checklistTemplate.findUnique({
        where: { id },
        include: { appliesToAssetClass: true, assignments: { select: { assetId: true } } },
      }),
    );
    if (!template || template.companyId !== companyId) {
      throw new NotFoundException({ code: 'CHECKLIST_TEMPLATE_NOT_FOUND', message: 'Checklist template not found.' });
    }
    return template;
  }

  async updateTemplate(companyId: string, actorUserId: string, id: string, dto: UpdateChecklistTemplateDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireTemplate(tx, companyId, id);

      const nextItems = dto.items !== undefined ? this.normalizeItems(dto.items) : undefined;
      const nextAppliesToAssetClassId =
        dto.appliesToAssetClass !== undefined
          ? await this.resolveAssetClassId(tx, dto.appliesToAssetClass)
          : undefined;

      // A change to the checklist's *content* (items or which class it targets)
      // bumps the version so completed submissions stay pinned to the wording they
      // were answered against. Renaming alone is not a content change.
      const contentChanged =
        (nextItems !== undefined && JSON.stringify(nextItems) !== JSON.stringify(existing.items)) ||
        (nextAppliesToAssetClassId !== undefined && nextAppliesToAssetClassId !== existing.appliesToAssetClassId);

      const template = await tx.checklistTemplate.update({
        where: { id },
        data: {
          name: dto.name,
          appliesToAssetClassId: nextAppliesToAssetClassId,
          items: nextItems !== undefined ? (nextItems as unknown as Prisma.InputJsonValue) : undefined,
          version: contentChanged ? { increment: 1 } : undefined,
        },
        include: { appliesToAssetClass: true },
      });

      // Only touch assignments when the caller sent the field (undefined = leave
      // as-is; [] = clear).
      if (dto.assignedAssetIds !== undefined) {
        await this.syncAssignments(tx, companyId, template.id, dto.assignedAssetIds);
      }

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.CHECKLIST_TEMPLATE,
        entityId: template.id,
        eventType: 'updated',
        summary: contentChanged
          ? `Checklist template "${template.name}" updated to v${template.version}.`
          : `Checklist template "${template.name}" updated.`,
        actorUserId,
      });

      return this.templateWithAssignments(tx, template.id);
    });
  }

  async archiveTemplate(companyId: string, actorUserId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireTemplate(tx, companyId, id);
      if (existing.archivedAt) {
        return tx.checklistTemplate.findUnique({ where: { id }, include: { appliesToAssetClass: true } });
      }

      const template = await tx.checklistTemplate.update({
        where: { id },
        data: { archivedAt: new Date() },
        include: { appliesToAssetClass: true },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.CHECKLIST_TEMPLATE,
        entityId: template.id,
        eventType: 'archived',
        summary: `Checklist template "${template.name}" archived.`,
        actorUserId,
      });

      return template;
    });
  }

  // ---- Submissions (operator-completed, DriverOS) -------------------------

  async submit(companyId: string, actorUserId: string, dto: SubmitChecklistDto) {
    const snapshot = this.normalizeItems(dto.templateSnapshot);
    return this.prisma.withTenant(companyId, async (tx) => {
      // Idempotent replay: a client-provided id that already exists is returned
      // as-is (the offline outbox may re-send after a lost success response).
      if (dto.id) {
        const existing = await tx.checklistSubmission.findUnique({
          where: { id: dto.id },
          include: this.submissionInclude(),
        });
        if (existing) {
          return { ...existing, createdMaintenanceJobIds: [] as string[], idempotentReplay: true };
        }
      }

      const template = await this.requireTemplate(tx, companyId, dto.templateId);
      const asset = await this.requireAsset(tx, companyId, dto.assetId);
      const operatorId = await this.resolveOperatorId(tx, actorUserId);

      const answers = this.validateAnswers(snapshot, dto.answers);
      const hasFailures = answers.some((a) => a.status === 'fail');

      const submission = await tx.checklistSubmission.create({
        data: {
          id: dto.id,
          companyId,
          templateId: template.id,
          templateVersion: dto.templateVersion,
          templateSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          assetId: asset.id,
          operatorId,
          answers: answers as unknown as Prisma.InputJsonValue,
          hasFailures,
          startedAt: dto.startedAt ? new Date(dto.startedAt) : undefined,
        },
        include: this.submissionInclude(),
      });

      const failCount = answers.filter((a) => a.status === 'fail').length;
      const summary = `Pre-start checklist "${template.name}" completed — ${answers.length} checks, ${failCount} failed.`;

      // "Every completed checklist becomes a permanent Timeline event on the
      // relevant asset and operator" (Smart_Checklists.md).
      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.ASSET,
        entityId: asset.id,
        eventType: 'checklist_completed',
        summary,
        payload: { submissionId: submission.id, hasFailures, failCount },
        actorUserId,
      });
      if (operatorId) {
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.OPERATOR,
          entityId: operatorId,
          eventType: 'checklist_completed',
          summary,
          payload: { submissionId: submission.id, assetId: asset.id, hasFailures },
          actorUserId,
        });
      }
      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.CHECKLIST_SUBMISSION,
        entityId: submission.id,
        eventType: 'created',
        summary,
        actorUserId,
      });

      // Downstream action: a failed item flagged createsFaultOnFail produces a
      // workshop MaintenanceJob with no further operator data entry — the spec's
      // headline acceptance criterion. Created inline (not via MaintenanceService,
      // which opens its own transaction) so the checklist and its faults commit
      // atomically.
      const answerByItemId = new Map(answers.map((a) => [a.itemId, a]));
      const createdMaintenanceJobIds: string[] = [];
      for (const item of snapshot) {
        const answer = answerByItemId.get(item.id);
        if (!item.createsFaultOnFail || answer?.status !== 'fail') continue;

        const job = await tx.maintenanceJob.create({
          data: {
            companyId,
            assetId: asset.id,
            title: `Checklist fault: ${item.label}`,
            description: answer.note
              ? `Auto-created from pre-start checklist "${template.name}". Operator note: ${answer.note}`
              : `Auto-created from pre-start checklist "${template.name}".`,
            reportedByOperatorId: operatorId,
          },
        });
        createdMaintenanceJobIds.push(job.id);

        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.MAINTENANCE_JOB,
          entityId: job.id,
          eventType: 'created',
          summary: `Maintenance job "${job.title}" logged from a pre-start checklist.`,
          payload: { submissionId: submission.id },
          actorUserId,
        });
      }

      // A pre-start that raised workshop jobs needs the workshop to know.
      if (createdMaintenanceJobIds.length > 0) {
        await this.notifications.notifyPermissionInTx(
          tx,
          companyId,
          PERMISSIONS.MAINTENANCE_VIEW,
          {
            type: 'fault_raised',
            title: `${createdMaintenanceJobIds.length} workshop job(s) from a pre-start`,
            body: `${asset.name}: ${template.name}`,
            linkPath: '/maintenance',
          },
          actorUserId,
        );
      }

      return { ...submission, createdMaintenanceJobIds, idempotentReplay: false };
    });
  }

  async findAllSubmissions(companyId: string, query: ListChecklistSubmissionsDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const where: Prisma.ChecklistSubmissionWhereInput = {
        ...(query.assetId ? { assetId: query.assetId } : {}),
      };
      const [items, total] = await Promise.all([
        tx.checklistSubmission.findMany({
          where,
          include: this.submissionInclude(),
          orderBy: { submittedAt: 'desc' },
          skip: query.skip,
          take: query.take,
        }),
        tx.checklistSubmission.count({ where }),
      ]);
      return { items, total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  /**
   * Office-facing read-model (Smart_Checklists.md Workflow #4: "Office sees
   * completed/incomplete checklist status for every asset"): for each active
   * asset, whether its pre-start checklist has been completed *today* and, if
   * so, whether it recorded any failures. Pure computation over existing
   * submissions — no stored state, the same shape as Fleet Health Score. "Today"
   * is the server's calendar day; scheduling/assignment is deferred, so the
   * expectation modeled here is simply "every active asset does a daily
   * pre-start."
   */
  async todayStatus(companyId: string) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);

    return this.prisma.withTenant(companyId, async (tx) => {
      const [assets, submissions] = await Promise.all([
        tx.asset.findMany({ where: { archivedAt: null }, orderBy: { name: 'asc' } }),
        tx.checklistSubmission.findMany({
          where: { submittedAt: { gte: dayStart } },
          orderBy: { submittedAt: 'desc' },
          include: {
            template: { select: { name: true } },
            operator: { select: { fullName: true } },
          },
          // Bounded: this loads today's submissions to reduce to latest-per-asset
          // in JS. MAX_AGGREGATION_ROWS is far above any fleet's daily pre-start
          // volume; ordered newest-first, so the latest-per-asset result is
          // unaffected until a tenant is doing tens of thousands of checks a day.
          take: MAX_AGGREGATION_ROWS,
        }),
      ]);

      // The most recent submission today wins per asset (list is newest-first).
      const latestByAsset = new Map<string, (typeof submissions)[number]>();
      for (const submission of submissions) {
        if (!latestByAsset.has(submission.assetId)) latestByAsset.set(submission.assetId, submission);
      }

      const items = assets.map((asset) => {
        const submission = latestByAsset.get(asset.id);
        return {
          asset: { id: asset.id, name: asset.name },
          status: submission ? ('done' as const) : ('not_done' as const),
          hasFailures: submission?.hasFailures ?? false,
          submittedAt: submission?.submittedAt ?? null,
          submissionId: submission?.id ?? null,
          operatorName: submission?.operator?.fullName ?? null,
          templateName: submission?.template?.name ?? null,
        };
      });

      return {
        date: dayStart,
        summary: {
          total: items.length,
          done: items.filter((i) => i.status === 'done').length,
          notDone: items.filter((i) => i.status === 'not_done').length,
          withFailures: items.filter((i) => i.hasFailures).length,
        },
        items,
      };
    });
  }

  async findOneSubmission(companyId: string, id: string) {
    const submission = await this.prisma.withTenant(companyId, (tx) =>
      tx.checklistSubmission.findUnique({ where: { id }, include: this.submissionInclude() }),
    );
    if (!submission || submission.companyId !== companyId) {
      throw new NotFoundException({ code: 'CHECKLIST_SUBMISSION_NOT_FOUND', message: 'Checklist submission not found.' });
    }
    return submission;
  }

  // ---- helpers ------------------------------------------------------------

  private submissionInclude() {
    return {
      template: { select: { id: true, name: true } },
      asset: { select: { id: true, name: true } },
      operator: { select: { id: true, fullName: true } },
    } satisfies Prisma.ChecklistSubmissionInclude;
  }

  /** Collapses optional booleans to explicit values and rejects duplicate item ids. */
  private normalizeItems(items: ChecklistItemDto[]): NormalizedItem[] {
    const seen = new Set<string>();
    return items.map((item) => {
      if (seen.has(item.id)) {
        throw new BadRequestException({
          code: 'CHECKLIST_DUPLICATE_ITEM_ID',
          message: `Duplicate checklist item id "${item.id}".`,
        });
      }
      seen.add(item.id);
      return {
        id: item.id,
        label: item.label,
        type: item.type,
        requireNoteOnFail: item.requireNoteOnFail ?? false,
        createsFaultOnFail: item.createsFaultOnFail ?? false,
      };
    });
  }

  /**
   * Validates the operator's answers against the snapshot they were shown: the
   * checklist must be fully answered, every answer must map to a real item, "n/a"
   * is only allowed where the item permits it, and a fail on a note-required item
   * must carry a note. Returns the answers in snapshot order.
   */
  private validateAnswers(
    snapshot: NormalizedItem[],
    answers: SubmitChecklistDto['answers'],
  ): { itemId: string; status: 'pass' | 'fail' | 'na' | null; note: string | null }[] {
    const answerByItemId = new Map<string, (typeof answers)[number]>();
    for (const answer of answers) {
      if (answerByItemId.has(answer.itemId)) {
        throw new BadRequestException({
          code: 'CHECKLIST_DUPLICATE_ANSWER',
          message: `Duplicate answer for item "${answer.itemId}".`,
        });
      }
      answerByItemId.set(answer.itemId, answer);
    }

    const itemById = new Map(snapshot.map((item) => [item.id, item]));
    for (const answer of answers) {
      if (!itemById.has(answer.itemId)) {
        throw new BadRequestException({
          code: 'CHECKLIST_UNKNOWN_ITEM',
          message: `Answer references unknown item "${answer.itemId}".`,
        });
      }
    }

    return snapshot.map((item) => {
      const answer = answerByItemId.get(item.id);
      if (!answer) {
        throw new BadRequestException({
          code: 'CHECKLIST_INCOMPLETE',
          message: `Checklist item "${item.label}" was not answered.`,
        });
      }
      const note = answer.note?.trim() ? answer.note.trim() : null;

      // A written-answer item: the typed response is the answer, there is no
      // pass/fail. An empty response counts as unanswered.
      if (item.type === 'text') {
        if (!note) {
          throw new BadRequestException({
            code: 'CHECKLIST_INCOMPLETE',
            message: `Checklist item "${item.label}" needs a written answer.`,
          });
        }
        return { itemId: item.id, status: null, note };
      }

      if (!answer.status) {
        throw new BadRequestException({
          code: 'CHECKLIST_INCOMPLETE',
          message: `Checklist item "${item.label}" was not answered.`,
        });
      }
      if (answer.status === 'na' && item.type !== 'pass_fail_na') {
        throw new BadRequestException({
          code: 'CHECKLIST_NA_NOT_ALLOWED',
          message: `Item "${item.label}" cannot be marked not-applicable.`,
        });
      }
      if (answer.status === 'fail' && item.requireNoteOnFail && !note) {
        throw new BadRequestException({
          code: 'CHECKLIST_NOTE_REQUIRED',
          message: `A note is required to fail "${item.label}".`,
        });
      }
      return { itemId: item.id, status: answer.status, note };
    });
  }

  private async resolveAssetClassId(
    tx: Prisma.TransactionClient,
    key: string | undefined,
  ): Promise<string | null> {
    if (!key || key === 'ANY') return null;
    // RLS scopes this to the company's own categories + shared built-ins;
    // prefer a company-specific category over a built-in of the same key.
    const assetClass = await tx.assetClass.findFirst({ where: { key, archivedAt: null }, orderBy: { companyId: 'asc' } });
    if (!assetClass) {
      throw new NotFoundException({ code: 'ASSET_CLASS_NOT_FOUND', message: 'Asset category not found.' });
    }
    return assetClass.id;
  }

  /** The submitting user's linked Operator, if any — never trusted from the client. */
  private async resolveOperatorId(tx: Prisma.TransactionClient, actorUserId: string): Promise<string | null> {
    const operator = await tx.operator.findFirst({ where: { userId: actorUserId, archivedAt: null } });
    return operator?.id ?? null;
  }

  private async requireTemplate(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const template = await tx.checklistTemplate.findUnique({ where: { id } });
    if (!template || template.companyId !== companyId) {
      throw new NotFoundException({ code: 'CHECKLIST_TEMPLATE_NOT_FOUND', message: 'Checklist template not found.' });
    }
    return template;
  }

  private async requireAsset(tx: Prisma.TransactionClient, companyId: string, assetId: string) {
    const asset = await tx.asset.findUnique({ where: { id: assetId } });
    if (!asset || asset.companyId !== companyId || asset.archivedAt) {
      throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: 'Asset not found.' });
    }
    return asset;
  }

  /** Re-fetch a template with its class + the ids of the assets it's assigned to. */
  private templateWithAssignments(tx: Prisma.TransactionClient, id: string) {
    return tx.checklistTemplate.findUnique({
      where: { id },
      include: { appliesToAssetClass: true, assignments: { select: { assetId: true } } },
    });
  }

  /**
   * Replace the set of specific assets a template is assigned to. Validates every
   * asset belongs to the tenant (the findMany runs under RLS, so a foreign id
   * simply isn't found), then swaps the whole set. Assignments are added/removed,
   * never updated — a delete-all + createMany is the simplest correct sync.
   */
  private async syncAssignments(
    tx: Prisma.TransactionClient,
    companyId: string,
    templateId: string,
    assetIds: string[],
  ) {
    const unique = [...new Set(assetIds)];
    if (unique.length > 0) {
      const found = await tx.asset.findMany({
        where: { id: { in: unique }, archivedAt: null },
        select: { id: true },
      });
      if (found.length !== unique.length) {
        throw new NotFoundException({
          code: 'ASSET_NOT_FOUND',
          message: 'One or more assigned assets were not found.',
        });
      }
    }
    await tx.checklistTemplateAssignment.deleteMany({ where: { templateId } });
    if (unique.length > 0) {
      await tx.checklistTemplateAssignment.createMany({
        data: unique.map((assetId) => ({ companyId, templateId, assetId })),
      });
    }
  }
}
