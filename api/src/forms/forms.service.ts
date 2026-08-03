import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { CreateFormTemplateDto } from './dto/create-form-template.dto';
import { UpdateFormTemplateDto } from './dto/update-form-template.dto';
import { ListFormTemplatesDto } from './dto/list-form-templates.dto';
import { SubmitFormDto } from './dto/submit-form.dto';
import { ListFormSubmissionsDto } from './dto/list-form-submissions.dto';
import { FormFieldDto, FormFieldType, isSelectType } from './dto/form-field.dto';
import { FormAnswerDto } from './dto/form-answer.dto';
import { assertOwnership, assertOwnedRecord } from '../common/ownership';

/** The normalized field shape persisted in `fields` / `template_snapshot` JSON. */
interface NormalizedField {
  id: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  options: string[] | null;
  showIfFieldId: string | null;
  showIfValue: string | null;
}

interface AnswerRecord {
  fieldId: string;
  value: unknown;
}

/**
 * Reference material is summarised, never inlined — a template read tells the
 * client there's a PDF and how big it is; the bytes come from the dedicated
 * download route only when someone opens it.
 */
const TEMPLATE_INCLUDE = {
  referenceDocument: {
    select: {
      id: true,
      title: true,
      fileAttachment: { select: { filename: true, contentType: true, byteSize: true } },
    },
  },
} satisfies Prisma.FormTemplateInclude;

/**
 * 01-Product/Universal_Forms.md's scoped slice: a data-driven form builder
 * (text/number/single & multi select/date/asset & operator reference fields,
 * single-level conditional show/hide) sharing ChecklistsService's
 * versioning/snapshot pattern rather than a full branching-tree engine. See
 * the doc's own Implementation notes for what's deliberately not built
 * (photo/signature/GPS capture, multi-branch trees, notification-on-branch
 * triggers).
 */
@Injectable()
export class FormsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly attachments: AttachmentsService,
  ) {}

  /** Same guard as KnowledgeService: a cross-tenant id reads as "not found". */
  private async requireDocument(tx: Prisma.TransactionClient, companyId: string, documentId: string) {
    await assertOwnership(tx.document, documentId, companyId, {
      code: 'DOCUMENT_NOT_FOUND',
      message: 'Document not found.',
      allowArchived: true,
    });
  }

  // ---- Templates (office-managed, FleetHQ) --------------------------------

  async createTemplate(companyId: string, actorUserId: string, dto: CreateFormTemplateDto) {
    const fields = this.normalizeFields(dto.fields);
    return this.prisma.withTenant(companyId, async (tx) => {
      if (dto.referenceDocumentId) await this.requireDocument(tx, companyId, dto.referenceDocumentId);
      const template = await tx.formTemplate.create({
        data: {
          companyId,
          name: dto.name,
          description: dto.description,
          targetContext: dto.targetContext ?? 'BOTH',
          fields: fields as unknown as Prisma.InputJsonValue,
          referenceDocumentId: dto.referenceDocumentId ?? null,
        },
        include: TEMPLATE_INCLUDE,
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.FORM_TEMPLATE,
        entityId: template.id,
        eventType: 'created',
        summary: `Form template "${template.name}" created.`,
        actorUserId,
      });

      return template;
    });
  }

  async findAllTemplates(companyId: string, query: ListFormTemplatesDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const where: Prisma.FormTemplateWhereInput = {
        ...(query.includeArchived ? {} : { archivedAt: null }),
        ...(query.targetContext ? { targetContext: { in: [query.targetContext, 'BOTH'] } } : {}),
      };
      const [items, total] = await Promise.all([
        tx.formTemplate.findMany({
          where,
          orderBy: { name: 'asc' },
          include: TEMPLATE_INCLUDE,
          skip: query.skip,
          take: query.take,
        }),
        tx.formTemplate.count({ where }),
      ]);
      return { items, total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async findOneTemplate(companyId: string, id: string) {
    const template = await this.prisma.withTenant(companyId, (tx) =>
      tx.formTemplate.findUnique({ where: { id }, include: TEMPLATE_INCLUDE }),
    );
    return assertOwnedRecord(template, companyId, {
      code: 'FORM_TEMPLATE_NOT_FOUND',
      message: 'Form template not found.',
      allowArchived: true,
    });
  }

  /**
   * The bytes of a template's reference document, served from the *forms* route
   * so `forms:view` is enough — an operator filling in a form must be able to
   * read the work instruction attached to it without also being granted access
   * to the whole document library.
   *
   * Honest limitation: this needs connectivity. DriverOS caches the form itself
   * (forms submit fine offline), but the reference PDF is fetched on demand and
   * won't open in a dead spot. Nothing about *completing* the form depends on it.
   */
  async downloadTemplateReference(companyId: string, id: string) {
    const attachmentId = await this.prisma.withTenant(companyId, async (tx) => {
      const template = await tx.formTemplate.findUnique({
        where: { id },
        select: { companyId: true, referenceDocument: { select: { fileAttachmentId: true } } },
      });
      const owned = assertOwnedRecord(template, companyId, {
        code: 'FORM_REFERENCE_NOT_FOUND',
        message: 'No reference document on this form.',
        allowArchived: true,
      });
      if (!owned.referenceDocument) {
        throw new NotFoundException({ code: 'FORM_REFERENCE_NOT_FOUND', message: 'No reference document on this form.' });
      }
      return owned.referenceDocument.fileAttachmentId;
    });
    return this.attachments.getForDownload(companyId, attachmentId);
  }

  async updateTemplate(companyId: string, actorUserId: string, id: string, dto: UpdateFormTemplateDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireTemplate(tx, companyId, id);

      const nextFields = dto.fields !== undefined ? this.normalizeFields(dto.fields) : undefined;
      const contentChanged =
        nextFields !== undefined && JSON.stringify(nextFields) !== JSON.stringify(existing.fields);
      if (dto.referenceDocumentId) await this.requireDocument(tx, companyId, dto.referenceDocumentId);

      const template = await tx.formTemplate.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description,
          targetContext: dto.targetContext,
          fields: nextFields !== undefined ? (nextFields as unknown as Prisma.InputJsonValue) : undefined,
          referenceDocumentId: dto.referenceDocumentId === undefined ? undefined : dto.referenceDocumentId,
          version: contentChanged ? { increment: 1 } : undefined,
        },
        include: TEMPLATE_INCLUDE,
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.FORM_TEMPLATE,
        entityId: template.id,
        eventType: 'updated',
        summary: contentChanged
          ? `Form template "${template.name}" updated to v${template.version}.`
          : `Form template "${template.name}" updated.`,
        actorUserId,
      });

      return template;
    });
  }

  async archiveTemplate(companyId: string, actorUserId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireTemplate(tx, companyId, id);
      if (existing.archivedAt) return existing;

      const template = await tx.formTemplate.update({ where: { id }, data: { archivedAt: new Date() } });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.FORM_TEMPLATE,
        entityId: template.id,
        eventType: 'archived',
        summary: `Form template "${template.name}" archived.`,
        actorUserId,
      });

      return template;
    });
  }

  // ---- Submissions ---------------------------------------------------------

  async submit(companyId: string, actorUserId: string, dto: SubmitFormDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      // Idempotent replay: a client-provided id that already exists is returned
      // as-is (the offline outbox may re-send after a lost success response).
      if (dto.id) {
        const existing = await tx.formSubmission.findUnique({ where: { id: dto.id }, include: this.submissionInclude() });
        if (existing) return { ...existing, idempotentReplay: true };
      }

      const template = await this.requireTemplate(tx, companyId, dto.templateId);
      const snapshot = this.normalizeFields(dto.templateSnapshot);
      const answers = await this.validateAnswers(tx, companyId, snapshot, dto.answers);

      const submission = await tx.formSubmission.create({
        data: {
          id: dto.id,
          companyId,
          templateId: template.id,
          templateVersion: dto.templateVersion,
          templateSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          answers: answers as unknown as Prisma.InputJsonValue,
          submittedByUserId: actorUserId,
        },
        include: this.submissionInclude(),
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.FORM_SUBMISSION,
        entityId: submission.id,
        eventType: 'created',
        summary: `Form "${template.name}" submitted.`,
        actorUserId,
      });

      // Universal_Forms.md: "Submitted forms produce Timeline events on every
      // entity they reference" — every asset_ref/operator_ref field with an
      // answered value gets one, in addition to the submission's own event.
      const answerByFieldId = new Map(answers.map((a) => [a.fieldId, a.value]));
      for (const field of snapshot) {
        if (field.type !== 'asset_ref' && field.type !== 'operator_ref') continue;
        const value = answerByFieldId.get(field.id);
        if (typeof value !== 'string') continue;

        await this.timeline.record(tx, {
          companyId,
          entityType: field.type === 'asset_ref' ? TimelineEntityType.ASSET : TimelineEntityType.OPERATOR,
          entityId: value,
          eventType: 'form_submitted',
          summary: `Form "${template.name}" submitted, referencing this ${field.type === 'asset_ref' ? 'asset' : 'operator'}.`,
          payload: { submissionId: submission.id, templateId: template.id },
          actorUserId,
        });
      }

      return { ...submission, idempotentReplay: false };
    });
  }

  async findAllSubmissions(companyId: string, query: ListFormSubmissionsDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const where: Prisma.FormSubmissionWhereInput = {
        ...(query.templateId ? { templateId: query.templateId } : {}),
      };
      const [items, total] = await Promise.all([
        tx.formSubmission.findMany({
          where,
          include: this.submissionInclude(),
          orderBy: { submittedAt: 'desc' },
          skip: query.skip,
          take: query.take,
        }),
        tx.formSubmission.count({ where }),
      ]);
      return { items, total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async findOneSubmission(companyId: string, id: string) {
    const submission = await this.prisma.withTenant(companyId, (tx) =>
      tx.formSubmission.findUnique({ where: { id }, include: this.submissionInclude() }),
    );
    return assertOwnedRecord(submission, companyId, {
      code: 'FORM_SUBMISSION_NOT_FOUND',
      message: 'Form submission not found.',
      allowArchived: true,
    });
  }

  // ---- helpers --------------------------------------------------------------

  private submissionInclude() {
    return {
      template: { select: { id: true, name: true } },
      submittedByUser: { select: { id: true, fullName: true } },
    } satisfies Prisma.FormSubmissionInclude;
  }

  /** Dedupes ids, requires options on select types, and validates showIfFieldId references an earlier field. */
  private normalizeFields(fields: FormFieldDto[]): NormalizedField[] {
    const seen = new Set<string>();
    return fields.map((field, index) => {
      if (seen.has(field.id)) {
        throw new BadRequestException({ code: 'FORM_DUPLICATE_FIELD_ID', message: `Duplicate form field id "${field.id}".` });
      }
      seen.add(field.id);

      if (isSelectType(field.type) && (!field.options || field.options.length === 0)) {
        throw new BadRequestException({
          code: 'FORM_FIELD_OPTIONS_REQUIRED',
          message: `Field "${field.label}" is a select type and needs at least one option.`,
        });
      }

      if (field.showIfFieldId) {
        const controllerIndex = fields.findIndex((f) => f.id === field.showIfFieldId);
        if (controllerIndex === -1 || controllerIndex >= index) {
          throw new BadRequestException({
            code: 'FORM_INVALID_CONDITION',
            message: `Field "${field.label}"'s condition must reference a field declared earlier in the form.`,
          });
        }
      }

      return {
        id: field.id,
        label: field.label,
        type: field.type,
        required: field.required ?? false,
        options: field.options ?? null,
        showIfFieldId: field.showIfFieldId ?? null,
        showIfValue: field.showIfValue ?? null,
      };
    });
  }

  /**
   * Validates answers against the snapshot the user was shown: required
   * fields (unless conditionally hidden) must be answered, values must match
   * their field's type, select values must be from the declared options, and
   * asset_ref/operator_ref values must resolve to a real record in this
   * company. Fields hidden by their condition are dropped even if an answer
   * was sent for them, so a client-side UI bug never persists stale/hidden data.
   */
  private async validateAnswers(
    tx: Prisma.TransactionClient,
    companyId: string,
    snapshot: NormalizedField[],
    answers: FormAnswerDto[],
  ): Promise<AnswerRecord[]> {
    const answerByFieldId = new Map<string, unknown>();
    for (const answer of answers) {
      if (answerByFieldId.has(answer.fieldId)) {
        throw new BadRequestException({ code: 'FORM_DUPLICATE_ANSWER', message: `Duplicate answer for field "${answer.fieldId}".` });
      }
      answerByFieldId.set(answer.fieldId, answer.value);
    }

    const fieldIds = new Set(snapshot.map((f) => f.id));
    for (const answer of answers) {
      if (!fieldIds.has(answer.fieldId)) {
        throw new BadRequestException({ code: 'FORM_UNKNOWN_FIELD', message: `Answer references unknown field "${answer.fieldId}".` });
      }
    }

    const resolvedByFieldId = new Map<string, unknown>();
    const result: AnswerRecord[] = [];

    for (const field of snapshot) {
      const isVisible = this.isFieldVisible(field, resolvedByFieldId);
      if (!isVisible) continue;

      const rawValue = answerByFieldId.get(field.id);
      const isEmpty =
        rawValue === undefined ||
        rawValue === null ||
        rawValue === '' ||
        (Array.isArray(rawValue) && rawValue.length === 0);

      if (isEmpty) {
        if (field.required) {
          throw new BadRequestException({ code: 'FORM_FIELD_REQUIRED', message: `Field "${field.label}" is required.` });
        }
        resolvedByFieldId.set(field.id, undefined);
        continue;
      }

      const value = await this.validateFieldValue(tx, companyId, field, rawValue);
      resolvedByFieldId.set(field.id, value);
      result.push({ fieldId: field.id, value });
    }

    return result;
  }

  private isFieldVisible(field: NormalizedField, resolvedByFieldId: Map<string, unknown>): boolean {
    if (!field.showIfFieldId) return true;
    const controllerValue = resolvedByFieldId.get(field.showIfFieldId);
    if (controllerValue === undefined) return false;
    if (Array.isArray(controllerValue)) return controllerValue.includes(field.showIfValue);
    return String(controllerValue) === field.showIfValue;
  }

  private async validateFieldValue(
    tx: Prisma.TransactionClient,
    companyId: string,
    field: NormalizedField,
    value: unknown,
  ): Promise<unknown> {
    switch (field.type) {
      case 'text': {
        if (typeof value !== 'string') {
          throw new BadRequestException({ code: 'FORM_INVALID_VALUE', message: `Field "${field.label}" must be text.` });
        }
        return value.trim();
      }
      case 'number': {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new BadRequestException({ code: 'FORM_INVALID_VALUE', message: `Field "${field.label}" must be a number.` });
        }
        return value;
      }
      case 'date': {
        if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
          throw new BadRequestException({ code: 'FORM_INVALID_VALUE', message: `Field "${field.label}" must be a valid date.` });
        }
        return value;
      }
      case 'single_select': {
        if (typeof value !== 'string' || !field.options?.includes(value)) {
          throw new BadRequestException({ code: 'FORM_INVALID_VALUE', message: `Field "${field.label}" must be one of its options.` });
        }
        return value;
      }
      case 'multi_select': {
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && field.options?.includes(v))) {
          throw new BadRequestException({ code: 'FORM_INVALID_VALUE', message: `Field "${field.label}" must be a subset of its options.` });
        }
        return value;
      }
      case 'asset_ref': {
        if (typeof value !== 'string') {
          throw new BadRequestException({ code: 'FORM_INVALID_VALUE', message: `Field "${field.label}" must reference an asset.` });
        }
        await assertOwnership(tx.asset, value, companyId, {
          code: 'FORM_ASSET_NOT_FOUND',
          message: `Field "${field.label}" references an asset that doesn't exist.`,
          allowArchived: true,
        });
        return value;
      }
      case 'operator_ref': {
        if (typeof value !== 'string') {
          throw new BadRequestException({ code: 'FORM_INVALID_VALUE', message: `Field "${field.label}" must reference an operator.` });
        }
        await assertOwnership(tx.operator, value, companyId, {
          code: 'FORM_OPERATOR_NOT_FOUND',
          message: `Field "${field.label}" references an operator that doesn't exist.`,
          allowArchived: true,
        });
        return value;
      }
    }
  }

  private requireTemplate(tx: Prisma.TransactionClient, companyId: string, id: string) {
    return assertOwnership(tx.formTemplate, id, companyId, {
      code: 'FORM_TEMPLATE_NOT_FOUND',
      message: 'Form template not found.',
      allowArchived: true,
    });
  }
}
