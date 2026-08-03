import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { ComplianceService } from '../compliance/compliance.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { ListComplianceDocumentsDto } from '../compliance/dto/list-compliance-documents.dto';
import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';

@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly complianceService: ComplianceService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // actorUserId is optional so the Integration Sync Engine can create rows for
  // a SCHEDULED/webhook-triggered sync (no human in the loop) via this exact
  // path — TimelineService already attributes an absent actor to SYSTEM.
  async create(companyId: string, actorUserId: string | undefined, dto: CreateAssetDto) {
    // SERIALIZABLE + bounded retry so the plan seat-cap check-then-insert cannot
    // race: two concurrent creates at the limit would both read the same count
    // and both commit under the default READ COMMITTED, overshooting the cap.
    // Under SERIALIZABLE one of the pair aborts (40001) and the retry re-reads
    // the now-updated count, enforcing the limit correctly. See
    // PrismaService.withTenantSerializable.
    return this.prisma.withTenantSerializable(companyId, async (tx) => {
      await this.entitlements.assertWithinLimit(tx, companyId, 'assets');
      // Resolve the category by id (a picker) or key (built-in default / import).
      // RLS scopes the lookup to this company's own categories + the shared
      // built-ins, so a company can never attach an asset to another's category.
      const assetClass = dto.assetClassId
        ? await tx.assetClass.findFirst({ where: { id: dto.assetClassId, archivedAt: null } })
        : await tx.assetClass.findFirst({ where: { key: dto.assetClass ?? 'LAND', archivedAt: null }, orderBy: { companyId: 'asc' } });
      if (!assetClass) {
        throw new BadRequestException({ code: 'ASSET_CLASS_NOT_FOUND', message: 'Asset category not found.' });
      }

      await this.assertVinAndRegistrationFree(tx, dto, null);

      const asset = await tx.asset
        .create({
          data: {
            companyId,
            assetClassId: assetClass.id,
            name: dto.name,
            externalReference: dto.externalReference,
            emergencyContact: dto.emergencyContact,
            make: dto.make,
            model: dto.model,
            year: dto.year,
            vin: dto.vin,
            registration: dto.registration,
            odometer: dto.odometer,
            odometerUnit: dto.odometerUnit,
            customFields: dto.customFields as Prisma.InputJsonValue | undefined,
          },
          include: { assetClass: true },
        })
        .catch((error: unknown) => this.rethrowDuplicateAsset(error));

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.ASSET,
        entityId: asset.id,
        eventType: 'created',
        summary: `Asset "${asset.name}" created.`,
        actorUserId,
      });

      return asset;
    });
  }

  async findAll(companyId: string, query: ListQueryDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const term = query.searchTerm;
      const where: Prisma.AssetWhereInput = {
        ...(query.includeArchived ? {} : { archivedAt: null }),
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { make: { contains: term, mode: 'insensitive' } },
                { model: { contains: term, mode: 'insensitive' } },
                { registration: { contains: term, mode: 'insensitive' } },
                { vin: { contains: term, mode: 'insensitive' } },
                { externalReference: { contains: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        tx.asset.findMany({
          where,
          include: { assetClass: true },
          // Client-supplied sort, allowlisted (Round 3 High #8): only these columns
          // are sortable; anything else falls back to newest-first.
          orderBy: query.resolveOrderBy(['createdAt', 'name', 'registration'], { createdAt: 'desc' }),
          skip: query.skip,
          take: query.take,
        }),
        tx.asset.count({ where }),
      ]);
      return { items, total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async findOne(companyId: string, id: string) {
    const asset = await this.prisma.withTenant(companyId, (tx) =>
      tx.asset.findUnique({ where: { id }, include: { assetClass: true } }),
    );
    if (!asset || asset.companyId !== companyId) {
      throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: 'Asset not found.' });
    }
    return asset;
  }

  async update(companyId: string, actorUserId: string, id: string, dto: UpdateAssetDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireAsset(tx, companyId, id);

      const changed: Record<string, { from: unknown; to: unknown }> = {};
      const scalarFields = [
        'name',
        'externalReference',
        'emergencyContact',
        'make',
        'model',
        'year',
        'vin',
        'registration',
        'odometer',
        'odometerUnit',
      ] as const;
      for (const field of scalarFields) {
        if (dto[field] !== undefined && dto[field] !== existing[field]) {
          changed[field] = { from: existing[field], to: dto[field] };
        }
      }
      if (dto.customFields !== undefined) {
        changed.customFields = { from: existing.customFields, to: dto.customFields };
      }

      await this.assertVinAndRegistrationFree(tx, dto, id);

      const asset = await tx.asset
        .update({
          where: { id },
          data: {
            name: dto.name,
            externalReference: dto.externalReference,
            emergencyContact: dto.emergencyContact,
            make: dto.make,
            model: dto.model,
            year: dto.year,
            vin: dto.vin,
            registration: dto.registration,
            odometer: dto.odometer,
            odometerUnit: dto.odometerUnit,
            customFields: dto.customFields as Prisma.InputJsonValue | undefined,
          },
          include: { assetClass: true },
        })
        .catch((error: unknown) => this.rethrowDuplicateAsset(error));

      if (Object.keys(changed).length > 0) {
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.ASSET,
          entityId: asset.id,
          eventType: 'updated',
          summary: `Asset "${asset.name}" updated.`,
          payload: changed,
          actorUserId,
        });
      }

      return asset;
    });
  }

  async archive(companyId: string, actorUserId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireAsset(tx, companyId, id);
      if (existing.archivedAt) {
        return existing;
      }

      const asset = await tx.asset.update({
        where: { id },
        data: { archivedAt: new Date() },
        include: { assetClass: true },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.ASSET,
        entityId: asset.id,
        eventType: 'archived',
        summary: `Asset "${asset.name}" archived.`,
        actorUserId,
      });

      return asset;
    });
  }

  /**
   * The asset detail view's aggregate: the asset (with specs) plus the tracked
   * activity that already lives in related tables — recent maintenance jobs,
   * compliance documents, and checklist submissions — so a single request backs
   * the whole "open an asset and monitor it" page instead of the UI stitching
   * several list calls together. Everything is company-scoped by RLS.
   */
  async getDetail(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const asset = await tx.asset.findUnique({ where: { id }, include: { assetClass: true } });
      if (!asset || asset.companyId !== companyId) {
        throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: 'Asset not found.' });
      }

      const [maintenance, compliance, checklists, openMaintenanceCount] = await Promise.all([
        tx.maintenanceJob.findMany({
          where: { assetId: id },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { id: true, title: true, description: true, status: true, partsCost: true, laborCost: true, createdAt: true, completedAt: true },
        }),
        tx.complianceDocument.findMany({
          where: { assetId: id, archivedAt: null },
          orderBy: { expiresAt: 'asc' },
          take: 20,
          select: { id: true, documentType: true, documentNumber: true, expiresAt: true },
        }),
        tx.checklistSubmission.findMany({
          where: { assetId: id },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { id: true, hasFailures: true, createdAt: true, template: { select: { name: true } } },
        }),
        tx.maintenanceJob.count({ where: { assetId: id, status: { not: 'COMPLETE' } } }),
      ]);

      return {
        asset,
        maintenance,
        compliance,
        checklists,
        summary: {
          openMaintenanceCount,
          complianceCount: compliance.length,
          checklistCount: checklists.length,
        },
      };
    });
  }

  /**
   * Digital Glovebox v0 (01-Product/Digital_Glovebox.md): registration/
   * insurance/roadworthy status for this asset, reusing ComplianceService's
   * existing expiry computation directly rather than re-deriving it, plus the
   * asset's emergency contact. Gated on the same assets:view permission the
   * rest of this controller uses — no separate compliance:view check, since
   * this is scoped to one specific asset an operator is already allowed to
   * see (the same "no extra check for your own assigned context" precedent
   * Dispatch already established for a Job's nested Asset name).
   */
  async getGlovebox(companyId: string, assetId: string) {
    const asset = await this.findOne(companyId, assetId);

    const query = new ListComplianceDocumentsDto();
    query.assetId = assetId;
    query.pageSize = 50;
    const { items } = await this.complianceService.findAll(companyId, query);

    return {
      asset: {
        id: asset.id,
        name: asset.name,
        emergencyContact: asset.emergencyContact,
      },
      documents: items,
    };
  }

  /** The scanned file behind one of this asset's glovebox documents. Gated on
   *  assets:view (the same as the glovebox itself) via the controller. */
  async getGloveboxDocumentFile(companyId: string, assetId: string, documentId: string) {
    await this.findOne(companyId, assetId); // 404s a cross-tenant / unknown asset first.
    return this.complianceService.getDocumentFile(companyId, documentId, { assetId });
  }

  /**
   * The shared asset-ownership guard reused across services (a 404s for an
   * unknown/cross-tenant asset). `allowArchived` defaults to `true` — this
   * service's own update/archive callers accept an archived asset — but a
   * caller that must reject archived assets too (Compliance/Jobs/Maintenance,
   * where you can't file a document or job against a retired asset) passes
   * `{ allowArchived: false }` to fold that check in without a second lookup.
   */
  async requireAsset(
    tx: Prisma.TransactionClient,
    companyId: string,
    id: string,
    { allowArchived = true }: { allowArchived?: boolean } = {},
  ) {
    const asset = await tx.asset.findUnique({ where: { id } });
    if (!asset || asset.companyId !== companyId || (!allowArchived && asset.archivedAt)) {
      throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: 'Asset not found.' });
    }
    return asset;
  }

  /**
   * Reject a duplicate VIN / registration with a clear, field-specific 409
   * *before* the write, so the client gets an actionable message. The
   * partial-unique indexes (migration 20260723200000) remain the race-safe
   * backstop for two concurrent creates; this pre-check just makes the ordinary
   * case (re-entering an existing vehicle) friendly. RLS scopes the lookup to
   * the caller's company, matching every other query in this service.
   */
  private async assertVinAndRegistrationFree(
    tx: Prisma.TransactionClient,
    dto: { vin?: string | null; registration?: string | null },
    currentId: string | null,
  ): Promise<void> {
    const notSelf = currentId ? { id: { not: currentId } } : {};
    if (dto.vin) {
      const clash = await tx.asset.findFirst({ where: { vin: dto.vin, archivedAt: null, ...notSelf }, select: { id: true } });
      if (clash) {
        throw new ConflictException({ code: 'ASSET_VIN_TAKEN', message: 'Another active asset already uses this VIN.' });
      }
    }
    if (dto.registration) {
      const clash = await tx.asset.findFirst({ where: { registration: dto.registration, archivedAt: null, ...notSelf }, select: { id: true } });
      if (clash) {
        throw new ConflictException({
          code: 'ASSET_REGISTRATION_TAKEN',
          message: 'Another active asset already uses this registration.',
        });
      }
    }
  }

  /**
   * Backstop for the concurrent-create race the pre-check can't see: a raw
   * partial-unique violation (Prisma can't tell which field for a filtered
   * index, so the message is generic) becomes a 409 rather than a raw 500.
   * Non-P2002 errors are rethrown untouched. Typed `never` so callers can
   * `.catch(e => this.rethrowDuplicateAsset(e))` and still treat the awaited
   * value as the created/updated asset.
   */
  private rethrowDuplicateAsset(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException({ code: 'ASSET_DUPLICATE', message: 'Another active asset already uses this VIN or registration.' });
    }
    throw error;
  }
}
