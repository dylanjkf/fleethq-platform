import { Injectable } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { assertOwnership } from '../common/ownership';
import { CreateAttachedUnitDto } from './dto/create-attached-unit.dto';
import { UpdateAttachedUnitDto } from './dto/update-attached-unit.dto';

const PAIRED_WITH_RELATIONSHIP = 'PAIRED_WITH';

/**
 * The spec columns a create/update may set. Listed once so create and update
 * cannot drift, and so adding a field is a one-line change.
 */
const SPEC_FIELDS = ['make', 'model', 'year', 'vin', 'registration', 'notes', 'customFields'] as const;

/** Resolves each AttachedUnit's currently-paired Asset (if any), one query for the whole page. */
async function withCurrentAsset<T extends { id: string }>(
  tx: Prisma.TransactionClient,
  companyId: string,
  units: T[],
): Promise<(T & { currentAsset: { id: string; name: string } | null })[]> {
  if (units.length === 0) return [];
  const openPairings = await tx.graphRelationship.findMany({
    where: {
      companyId,
      sourceType: TimelineEntityType.ATTACHED_UNIT,
      sourceId: { in: units.map((u) => u.id) },
      relationshipType: PAIRED_WITH_RELATIONSHIP,
      validTo: null,
    },
  });
  const assetIds = openPairings.map((p) => p.targetId);
  const assets = assetIds.length > 0
    ? await tx.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, name: true } })
    : [];
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const assetIdByUnitId = new Map(openPairings.map((p) => [p.sourceId, p.targetId]));

  return units.map((unit) => ({
    ...unit,
    currentAsset: assetById.get(assetIdByUnitId.get(unit.id) ?? '') ?? null,
  }));
}

@Injectable()
export class AttachedUnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
  ) {}

  // actorUserId is optional so the Integration Sync Engine can create rows for
  // a SCHEDULED/webhook-triggered sync (no human in the loop) via this exact
  // path — TimelineService already attributes an absent actor to SYSTEM.
  async create(companyId: string, actorUserId: string | undefined, dto: CreateAttachedUnitDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const attachedUnit = await tx.attachedUnit.create({
        data: {
          companyId,
          name: dto.name,
          externalReference: dto.externalReference,
          make: dto.make,
          model: dto.model,
          year: dto.year,
          vin: dto.vin,
          registration: dto.registration,
          notes: dto.notes,
          customFields: dto.customFields as Prisma.InputJsonValue | undefined,
        },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.ATTACHED_UNIT,
        entityId: attachedUnit.id,
        eventType: 'created',
        summary: `Attached unit "${attachedUnit.name}" created.`,
        actorUserId,
      });

      return attachedUnit;
    });
  }

  async findAll(companyId: string, query: ListQueryDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const where = query.includeArchived ? {} : { archivedAt: null };
      const [rows, total] = await Promise.all([
        tx.attachedUnit.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: query.skip,
          take: query.take,
        }),
        tx.attachedUnit.count({ where }),
      ]);
      const items = await withCurrentAsset(tx, companyId, rows);
      return { items, total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async findOne(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const attachedUnit = await this.requireAttachedUnit(tx, companyId, id);
      const [withAsset] = await withCurrentAsset(tx, companyId, [attachedUnit]);
      return withAsset;
    });
  }

  /**
   * Everything the detail view shows: the unit with its specs, what it's hitched
   * to right now, and its hitch history resolved to asset names.
   *
   * History reads back the timed `PAIRED_WITH` GraphRelationship rows rather than
   * a separate log — the fleet graph already *is* the record of what was attached
   * to what and when (01-Product/Fleet_Graph.md), so querying it keeps one source
   * of truth instead of duplicating state. Asset names resolve in one batched
   * query, so a unit with a long history stays a fixed number of round trips.
   */
  async detail(companyId: string, id: string) {
    const unit = await this.findOne(companyId, id);
    return this.prisma.withTenant(companyId, async (tx) => {
      const pairings = await tx.graphRelationship.findMany({
        where: {
          companyId,
          sourceType: TimelineEntityType.ATTACHED_UNIT,
          sourceId: id,
          relationshipType: PAIRED_WITH_RELATIONSHIP,
        },
        orderBy: { validFrom: 'desc' },
        take: 100,
        select: { id: true, targetId: true, validFrom: true, validTo: true },
      });

      const assetIds = [...new Set(pairings.map((p) => p.targetId))];
      const assets = assetIds.length
        ? await tx.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, name: true } })
        : [];
      const nameById = new Map(assets.map((a) => [a.id, a.name]));

      return {
        ...unit,
        hitchHistory: pairings.map((p) => ({
          id: p.id,
          assetId: p.targetId,
          // An asset archived since the pairing shouldn't blank the row — that it
          // *was* hitched remains true and is worth showing.
          assetName: nameById.get(p.targetId) ?? 'Unknown asset',
          hitchedAt: p.validFrom,
          unhitchedAt: p.validTo,
          isCurrent: p.validTo === null,
        })),
      };
    });
  }

  async update(companyId: string, actorUserId: string, id: string, dto: UpdateAttachedUnitDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireAttachedUnit(tx, companyId, id);

      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const field of ['name', 'externalReference'] as const) {
        if (dto[field] !== undefined && dto[field] !== existing[field]) {
          changed[field] = { from: existing[field], to: dto[field] };
        }
      }
      // Spec edits are timeline-worthy too — a changed VIN or registration is
      // exactly the sort of thing an audit later needs to reconstruct.
      for (const field of SPEC_FIELDS) {
        if (dto[field] !== undefined && JSON.stringify(dto[field]) !== JSON.stringify(existing[field])) {
          changed[field] = { from: existing[field], to: dto[field] };
        }
      }

      const attachedUnit = await tx.attachedUnit.update({
        where: { id },
        data: {
          name: dto.name,
          externalReference: dto.externalReference,
          make: dto.make,
          model: dto.model,
          year: dto.year,
          vin: dto.vin,
          registration: dto.registration,
          notes: dto.notes,
          customFields: dto.customFields as Prisma.InputJsonValue | undefined,
        },
      });

      if (Object.keys(changed).length > 0) {
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.ATTACHED_UNIT,
          entityId: attachedUnit.id,
          eventType: 'updated',
          summary: `Attached unit "${attachedUnit.name}" updated.`,
          payload: changed,
          actorUserId,
        });
      }

      return attachedUnit;
    });
  }

  async archive(companyId: string, actorUserId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireAttachedUnit(tx, companyId, id);
      if (existing.archivedAt) {
        return existing;
      }

      const attachedUnit = await tx.attachedUnit.update({
        where: { id },
        data: { archivedAt: new Date() },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.ATTACHED_UNIT,
        entityId: attachedUnit.id,
        eventType: 'archived',
        summary: `Attached unit "${attachedUnit.name}" archived.`,
        actorUserId,
      });

      return attachedUnit;
    });
  }

  /**
   * Completes 01-Product/Fleet_Graph.md's second documented workflow ("when
   * an attached unit is hitched to an asset, a timed PAIRED_WITH relationship
   * is created") — unbuilt until now since AttachedUnit shipped as CRUD-only.
   * An attached unit can only be paired with one asset at a time, so hitching
   * to a new asset closes any existing open pairing first; an asset having
   * several attached units paired to it simultaneously (a road train) is not
   * constrained on the asset side.
   */
  async hitch(companyId: string, actorUserId: string, id: string, assetId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const attachedUnit = await this.requireAttachedUnit(tx, companyId, id);
      const asset = await assertOwnership(tx.asset, assetId, companyId, {
        code: 'ASSET_NOT_FOUND',
        message: 'Asset not found.',
        allowArchived: false,
      });

      await tx.graphRelationship.updateMany({
        where: {
          companyId,
          sourceType: TimelineEntityType.ATTACHED_UNIT,
          sourceId: id,
          relationshipType: PAIRED_WITH_RELATIONSHIP,
          validTo: null,
        },
        data: { validTo: new Date() },
      });

      await tx.graphRelationship.create({
        data: {
          companyId,
          sourceType: TimelineEntityType.ATTACHED_UNIT,
          sourceId: id,
          targetType: TimelineEntityType.ASSET,
          targetId: assetId,
          relationshipType: PAIRED_WITH_RELATIONSHIP,
        },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.ATTACHED_UNIT,
        entityId: id,
        eventType: 'hitched',
        summary: `Attached unit "${attachedUnit.name}" hitched to asset "${asset.name}".`,
        actorUserId,
      });

      const [withAsset] = await withCurrentAsset(tx, companyId, [attachedUnit]);
      return withAsset;
    });
  }

  /** No-op (not an error) if the attached unit isn't currently paired with anything. */
  async unhitch(companyId: string, actorUserId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const attachedUnit = await this.requireAttachedUnit(tx, companyId, id);

      const openPairing = await tx.graphRelationship.findFirst({
        where: {
          companyId,
          sourceType: TimelineEntityType.ATTACHED_UNIT,
          sourceId: id,
          relationshipType: PAIRED_WITH_RELATIONSHIP,
          validTo: null,
        },
      });

      if (openPairing) {
        await tx.graphRelationship.update({ where: { id: openPairing.id }, data: { validTo: new Date() } });
        const asset = await tx.asset.findUnique({ where: { id: openPairing.targetId }, select: { name: true } });
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.ATTACHED_UNIT,
          entityId: id,
          eventType: 'unhitched',
          summary: `Attached unit "${attachedUnit.name}" unhitched from asset "${asset?.name ?? 'unknown'}".`,
          actorUserId,
        });
      }

      const [withAsset] = await withCurrentAsset(tx, companyId, [attachedUnit]);
      return withAsset;
    });
  }

  requireAttachedUnit(tx: Prisma.TransactionClient, companyId: string, id: string) {
    return assertOwnership(tx.attachedUnit, id, companyId, {
      code: 'ATTACHED_UNIT_NOT_FOUND',
      message: 'Attached unit not found.',
      allowArchived: true,
    });
  }
}
