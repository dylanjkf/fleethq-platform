import { Injectable } from '@nestjs/common';
import { TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_AGGREGATION_ROWS } from '../common/query/row-caps';

const PATTERN_WINDOW_DAYS = 180;
const RECURRING_FAULT_MIN_COUNT = 2;
const SHARED_UNIT_PATTERN_MIN_ASSETS = 2;

export type PredictiveSignalType = 'RECURRING_FAULT' | 'SHARED_ATTACHED_UNIT_PATTERN';

export interface PredictiveMaintenanceSignal {
  type: PredictiveSignalType;
  title: string;
  summary: string;
  occurrenceCount: number;
  assetIds: string[];
  assetNames: string[];
  attachedUnitId: string | null;
  attachedUnitName: string | null;
  maintenanceJobIds: string[];
}

interface FaultRow {
  id: string;
  assetId: string;
  title: string;
  createdAt: Date;
}

/**
 * 09-AI/Fleet_Intelligence_Overview.md's "predictive maintenance signals"
 * line, and 01-Product/Fleet_Graph.md's own named multi-hop example query
 * ("which attached units have repeatedly been paired with assets that later
 * developed the same [...] issue") — flagged as unbuilt in that doc's own
 * implementation notes ("no query language or aggregation exists for that
 * yet"). Built here as one deterministic pattern detector, with no AI/ML
 * model involved at all: per Core Principle 7 ("AI enhances, never blocks")
 * and the same "underlying rule check is deterministic" framing this
 * codebase already used for Fatigue/Hours, a real predictive signal needs a
 * working non-AI core before any AI enhancement sits on top of it — this IS
 * that core, not a stand-in for one.
 *
 * OBD/CAN-derived signals (this doc's other named data source) are not
 * built — no hardware integration exists yet (03-Hardware/OBD_CAN_Integration.md),
 * and this codebase never fakes a data source that doesn't exist. Everything
 * here reads only Maintenance fault history and Fleet Graph PAIRED_WITH
 * relationships, both of which are real.
 */
@Injectable()
export class PredictiveMaintenanceService {
  constructor(private readonly prisma: PrismaService) {}

  async getSignals(companyId: string): Promise<PredictiveMaintenanceSignal[]> {
    return this.prisma.withTenant(companyId, async (tx) => {
      const windowStart = new Date(Date.now() - PATTERN_WINDOW_DAYS * 24 * 60 * 60 * 1000);

      // Every fault in the pattern window is loaded and reduced in JS (grouped by
      // asset/title below), so cap the read: MAX_AGGREGATION_ROWS is far above any
      // real fleet's fault count in a 180-day window, but a hard bound so a
      // pathological history can't turn this into an unbounded scan.
      const faults: FaultRow[] = await tx.maintenanceJob.findMany({
        where: { createdAt: { gte: windowStart } },
        select: { id: true, assetId: true, title: true, createdAt: true },
        take: MAX_AGGREGATION_ROWS,
      });

      const pairings = await tx.graphRelationship.findMany({
        where: {
          relationshipType: 'PAIRED_WITH',
          sourceType: TimelineEntityType.ATTACHED_UNIT,
          targetType: TimelineEntityType.ASSET,
        },
        select: { sourceId: true, targetId: true, validFrom: true },
      });

      const relevantAssetIds = new Set<string>([...faults.map((f) => f.assetId), ...pairings.map((p) => p.targetId)]);
      const [assets, attachedUnits] = await Promise.all([
        tx.asset.findMany({ where: { id: { in: [...relevantAssetIds] } }, select: { id: true, name: true } }),
        tx.attachedUnit.findMany({ where: { id: { in: [...new Set(pairings.map((p) => p.sourceId))] } }, select: { id: true, name: true } }),
      ]);
      const assetName = new Map(assets.map((a) => [a.id, a.name]));
      const attachedUnitName = new Map(attachedUnits.map((u) => [u.id, u.name]));

      const faultsByAsset = new Map<string, FaultRow[]>();
      for (const f of faults) {
        if (!faultsByAsset.has(f.assetId)) faultsByAsset.set(f.assetId, []);
        faultsByAsset.get(f.assetId)!.push(f);
      }

      const signals: PredictiveMaintenanceSignal[] = [
        ...this.detectRecurringFaults(faultsByAsset, assetName),
        ...this.detectSharedAttachedUnitPatterns(pairings, faultsByAsset, assetName, attachedUnitName),
      ];

      signals.sort((a, b) => b.occurrenceCount - a.occurrenceCount);
      return signals;
    });
  }

  private detectRecurringFaults(
    faultsByAsset: Map<string, FaultRow[]>,
    assetName: Map<string, string>,
  ): PredictiveMaintenanceSignal[] {
    const signals: PredictiveMaintenanceSignal[] = [];
    for (const [assetId, assetFaults] of faultsByAsset) {
      const byTitle = new Map<string, FaultRow[]>();
      for (const f of assetFaults) {
        if (!byTitle.has(f.title)) byTitle.set(f.title, []);
        byTitle.get(f.title)!.push(f);
      }
      for (const [title, group] of byTitle) {
        if (group.length < RECURRING_FAULT_MIN_COUNT) continue;
        signals.push({
          type: 'RECURRING_FAULT',
          title,
          summary: `"${assetName.get(assetId) ?? 'Unknown asset'}" has had ${group.length} "${title}" faults in the last ${PATTERN_WINDOW_DAYS} days.`,
          occurrenceCount: group.length,
          assetIds: [assetId],
          assetNames: [assetName.get(assetId) ?? 'Unknown asset'],
          attachedUnitId: null,
          attachedUnitName: null,
          maintenanceJobIds: group.map((f) => f.id),
        });
      }
    }
    return signals;
  }

  private detectSharedAttachedUnitPatterns(
    pairings: { sourceId: string; targetId: string; validFrom: Date }[],
    faultsByAsset: Map<string, FaultRow[]>,
    assetName: Map<string, string>,
    attachedUnitName: Map<string, string>,
  ): PredictiveMaintenanceSignal[] {
    const signals: PredictiveMaintenanceSignal[] = [];

    const pairingsByUnit = new Map<string, { assetId: string; validFrom: Date }[]>();
    for (const p of pairings) {
      if (!pairingsByUnit.has(p.sourceId)) pairingsByUnit.set(p.sourceId, []);
      pairingsByUnit.get(p.sourceId)!.push({ assetId: p.targetId, validFrom: p.validFrom });
    }

    for (const [unitId, unitPairings] of pairingsByUnit) {
      const pairedSinceByAsset = new Map<string, Date>();
      for (const p of unitPairings) {
        const existing = pairedSinceByAsset.get(p.assetId);
        if (!existing || p.validFrom < existing) pairedSinceByAsset.set(p.assetId, p.validFrom);
      }
      if (pairedSinceByAsset.size < SHARED_UNIT_PATTERN_MIN_ASSETS) continue;

      const faultsByTitle = this.groupFaultsByTitleSincePairing(pairedSinceByAsset, faultsByAsset);

      for (const [title, entry] of faultsByTitle) {
        if (entry.assetIds.size < SHARED_UNIT_PATTERN_MIN_ASSETS) continue;
        const assetIds = [...entry.assetIds];
        signals.push({
          type: 'SHARED_ATTACHED_UNIT_PATTERN',
          title,
          summary: `${assetIds.length} assets paired with "${attachedUnitName.get(unitId) ?? 'Unknown attached unit'}" have developed a matching "${title}" fault.`,
          occurrenceCount: assetIds.length,
          assetIds,
          assetNames: assetIds.map((id) => assetName.get(id) ?? 'Unknown asset'),
          attachedUnitId: unitId,
          attachedUnitName: attachedUnitName.get(unitId) ?? 'Unknown attached unit',
          maintenanceJobIds: entry.jobIds,
        });
      }
    }
    return signals;
  }

  /**
   * Group the faults an asset developed *after* it was paired with a shared
   * attached unit, keyed by fault title. Extracted from
   * detectSharedAttachedUnitPatterns to keep that method within the nesting
   * limit and to give the "faults since pairing" step a name.
   */
  private groupFaultsByTitleSincePairing(
    pairedSinceByAsset: Map<string, Date>,
    faultsByAsset: Map<string, FaultRow[]>,
  ): Map<string, { assetIds: Set<string>; jobIds: string[] }> {
    const faultsByTitle = new Map<string, { assetIds: Set<string>; jobIds: string[] }>();
    for (const [assetId, pairedSince] of pairedSinceByAsset) {
      for (const f of faultsByAsset.get(assetId) ?? []) {
        if (f.createdAt < pairedSince) continue;
        if (!faultsByTitle.has(f.title)) faultsByTitle.set(f.title, { assetIds: new Set(), jobIds: [] });
        const entry = faultsByTitle.get(f.title)!;
        entry.assetIds.add(assetId);
        entry.jobIds.push(f.id);
      }
    }
    return faultsByTitle;
  }
}
