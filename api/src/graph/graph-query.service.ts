import { Injectable } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_AGGREGATION_ROWS } from '../common/query/row-caps';

export interface RelationshipItem {
  id: string;
  relationshipType: string;
  direction: 'outgoing' | 'incoming';
  otherType: TimelineEntityType;
  otherId: string;
  otherName: string;
  validFrom: Date;
  validTo: Date | null;
  isCurrent: boolean;
}

/** Only the entity types any relationship-writing workflow actually names today. */
async function resolveNames(
  tx: Prisma.TransactionClient,
  type: TimelineEntityType,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  switch (type) {
    case TimelineEntityType.ASSET: {
      const rows = await tx.asset.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      return new Map(rows.map((r) => [r.id, r.name]));
    }
    case TimelineEntityType.OPERATOR: {
      const rows = await tx.operator.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
      return new Map(rows.map((r) => [r.id, r.fullName]));
    }
    case TimelineEntityType.ATTACHED_UNIT: {
      const rows = await tx.attachedUnit.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      return new Map(rows.map((r) => [r.id, r.name]));
    }
    default:
      return new Map();
  }
}

/**
 * Read side of the Fleet Graph (`01-Product/Fleet_Graph.md`): the first
 * endpoint over `graph_relationships`, which until now only ever got written
 * to (the `OPERATED` relationship from Dispatch assignment), never read
 * back. Answers the doc's first Vision.md example query directly — "which
 * operators have operated this asset" and its inverse, "which assets has
 * this operator operated" — by resolving relationships in either direction
 * for the given entity.
 */
@Injectable()
export class GraphQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async listRelationships(
    companyId: string,
    entityType: TimelineEntityType,
    entityId: string,
  ): Promise<{ items: RelationshipItem[] }> {
    return this.prisma.withTenant(companyId, async (tx) => {
      const rows = await tx.graphRelationship.findMany({
        where: {
          companyId,
          OR: [
            { sourceType: entityType, sourceId: entityId },
            { targetType: entityType, targetId: entityId },
          ],
        },
        take: 200,
      });

      const otherIdsByType = new Map<TimelineEntityType, Set<string>>();
      for (const r of rows) {
        const isSource = r.sourceType === entityType && r.sourceId === entityId;
        const otherType = isSource ? r.targetType : r.sourceType;
        const otherId = isSource ? r.targetId : r.sourceId;
        if (!otherIdsByType.has(otherType)) otherIdsByType.set(otherType, new Set());
        otherIdsByType.get(otherType)!.add(otherId);
      }

      const namesByType = new Map<TimelineEntityType, Map<string, string>>();
      for (const [type, ids] of otherIdsByType) {
        namesByType.set(type, await resolveNames(tx, type, [...ids]));
      }

      const items: RelationshipItem[] = rows.map((r) => {
        const isSource = r.sourceType === entityType && r.sourceId === entityId;
        const otherType = isSource ? r.targetType : r.sourceType;
        const otherId = isSource ? r.targetId : r.sourceId;
        return {
          id: r.id,
          relationshipType: r.relationshipType,
          direction: isSource ? 'outgoing' : 'incoming',
          otherType,
          otherId,
          otherName: namesByType.get(otherType)?.get(otherId) ?? 'Unknown',
          validFrom: r.validFrom,
          validTo: r.validTo,
          isCurrent: r.validTo === null,
        };
      });

      items.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return b.validFrom.getTime() - a.validFrom.getTime();
      });

      return { items };
    });
  }

  /**
   * A company-wide roll-up of the Fleet Graph for the dashboard widget: how many
   * relationships are currently live (validTo null) vs recorded in total, a
   * breakdown by relationship type, and the most-connected assets. Answers "how
   * wired-up is my fleet" at a glance without needing to pick an entity first.
   */
  async summary(companyId: string): Promise<{
    currentCount: number;
    totalCount: number;
    linkedAssets: number;
    linkedOperators: number;
    byType: { relationshipType: string; current: number; total: number }[];
    topAssets: { assetId: string; assetName: string; connections: number }[];
  }> {
    return this.prisma.withTenant(companyId, async (tx) => {
      // Rolled up in JS (byType / topAssets / linked-entity sets below), so
      // bound the read: MAX_AGGREGATION_ROWS is far above any real fleet's
      // relationship count, but a hard ceiling so a pathological graph can't
      // turn this dashboard widget into an unbounded scan.
      const rows = await tx.graphRelationship.findMany({
        where: { companyId },
        select: {
          relationshipType: true,
          validTo: true,
          sourceType: true,
          sourceId: true,
          targetType: true,
          targetId: true,
        },
        take: MAX_AGGREGATION_ROWS,
      });

      const byType = new Map<string, { current: number; total: number }>();
      const assetConnections = new Map<string, number>();
      const linkedAssetIds = new Set<string>();
      const linkedOperatorIds = new Set<string>();
      let currentCount = 0;

      for (const r of rows) {
        const isCurrent = r.validTo === null;
        if (isCurrent) currentCount += 1;
        const t = byType.get(r.relationshipType) ?? { current: 0, total: 0 };
        t.total += 1;
        if (isCurrent) t.current += 1;
        byType.set(r.relationshipType, t);

        for (const end of [
          { type: r.sourceType, id: r.sourceId },
          { type: r.targetType, id: r.targetId },
        ]) {
          if (end.type === TimelineEntityType.OPERATOR) {
            linkedOperatorIds.add(end.id);
            continue;
          }
          if (end.type !== TimelineEntityType.ASSET) continue;
          linkedAssetIds.add(end.id);
          if (isCurrent) {
            assetConnections.set(end.id, (assetConnections.get(end.id) ?? 0) + 1);
          }
        }
      }

      const topAssetIds = [...assetConnections.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id]) => id);
      const assetNames = await resolveNames(tx, TimelineEntityType.ASSET, topAssetIds);
      const topAssets = topAssetIds.map((id) => ({
        assetId: id,
        assetName: assetNames.get(id) ?? 'Unknown',
        connections: assetConnections.get(id) ?? 0,
      }));

      return {
        currentCount,
        totalCount: rows.length,
        linkedAssets: linkedAssetIds.size,
        linkedOperators: linkedOperatorIds.size,
        byType: [...byType.entries()]
          .map(([relationshipType, v]) => ({ relationshipType, ...v }))
          .sort((a, b) => b.current - a.current || b.total - a.total),
        topAssets,
      };
    });
  }
}
