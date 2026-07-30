import { Injectable } from '@nestjs/common';
import { JobStatus, MaintenanceJobStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const BUSY_ASSET_PENALTY = 30;
const OPEN_MAINTENANCE_PENALTY = 20; // per open maintenance job
const OPEN_MAINTENANCE_CAP = 60;
const EXPIRED_DOC_PENALTY = 40;
const EXPIRING_SOON_PENALTY = 15;
const EXPIRING_SOON_DAYS = 30;
const MAINTENANCE_AGE_WEIGHT_CAP_DAYS = 30;
const MAINTENANCE_IN_USE_BONUS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AssetRecommendation {
  assetId: string;
  assetName: string;
  score: number;
  isBusy: boolean;
  reasons: string[];
}

export interface MaintenancePriorityItem {
  maintenanceJobId: string;
  assetId: string;
  assetName: string;
  title: string;
  ageDays: number;
  currentlyInUse: boolean;
  priorityScore: number;
  reasons: string[];
}

/**
 * 09-AI/Fleet_Intelligence_Overview.md's "operational recommendations" line:
 * "flagging which asset is best suited for a job, or which maintenance should
 * be prioritized next week, surfaced as suggestions, never automatic actions."
 * Both are deterministic rankings over data that already exists — no AI/ML
 * model. Nothing here assigns a job or reprioritizes anything on its own; a
 * human reads the ranking and decides.
 *
 * These used to lean on the Fleet Health *score* and maintenance *severity*;
 * both were removed as unhelpful abstractions, so the rankings now work
 * directly off the underlying facts (open maintenance jobs, compliance expiry,
 * fault age, current utilisation).
 */
@Injectable()
export class OperationalRecommendationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ranks active assets for a job assignment. Each asset starts at 100 and is
   * penalised for open maintenance jobs, expiring/expired compliance documents,
   * and being tied up on another open job. `excludeJobId` is the job being
   * edited, if any, so its own asset isn't penalised against itself.
   */
  async getAssetRecommendations(companyId: string, excludeJobId?: string): Promise<AssetRecommendation[]> {
    return this.prisma.withTenant(companyId, async (tx) => {
      const [assets, openMaint, docs, busyAssetIds] = await Promise.all([
        tx.asset.findMany({ where: { archivedAt: null }, select: { id: true, name: true } }),
        tx.maintenanceJob.findMany({ where: { status: { not: MaintenanceJobStatus.COMPLETE } }, select: { assetId: true } }),
        tx.complianceDocument.findMany({ where: { archivedAt: null, assetId: { not: null } }, select: { assetId: true, expiresAt: true } }),
        this.getBusyAssetIds(companyId, excludeJobId),
      ]);

      const openByAsset = new Map<string, number>();
      for (const m of openMaint) openByAsset.set(m.assetId, (openByAsset.get(m.assetId) ?? 0) + 1);

      const now = Date.now();
      const docState = new Map<string, 'expired' | 'soon'>();
      for (const d of docs) {
        if (!d.assetId) continue;
        const days = Math.floor((d.expiresAt.getTime() - now) / DAY_MS);
        if (days < 0) docState.set(d.assetId, 'expired');
        else if (days <= EXPIRING_SOON_DAYS && docState.get(d.assetId) !== 'expired') docState.set(d.assetId, 'soon');
      }

      const recommendations: AssetRecommendation[] = assets.map((asset) => {
        const reasons: string[] = [];
        let score = 100;

        const openCount = openByAsset.get(asset.id) ?? 0;
        if (openCount > 0) {
          score -= Math.min(openCount * OPEN_MAINTENANCE_PENALTY, OPEN_MAINTENANCE_CAP);
          reasons.push(`${openCount} open maintenance job${openCount === 1 ? '' : 's'}.`);
        }

        const ds = docState.get(asset.id);
        if (ds === 'expired') {
          score -= EXPIRED_DOC_PENALTY;
          reasons.push('A compliance document has expired.');
        } else if (ds === 'soon') {
          score -= EXPIRING_SOON_PENALTY;
          reasons.push('A compliance document expires soon.');
        }

        const isBusy = busyAssetIds.has(asset.id);
        if (isBusy) {
          score -= BUSY_ASSET_PENALTY;
          reasons.push('Already assigned to another open job.');
        }

        return { assetId: asset.id, assetName: asset.name, score: Math.max(0, score), isBusy, reasons };
      });

      recommendations.sort((a, b) => b.score - a.score);
      return recommendations;
    });
  }

  /**
   * Ranks currently-open maintenance jobs by how long they've been open (capped)
   * and whether the asset is currently tied to an open job (fix it before it
   * goes out again).
   */
  async getMaintenancePriority(companyId: string): Promise<MaintenancePriorityItem[]> {
    return this.prisma.withTenant(companyId, async (tx) => {
      const [jobs, busyAssetIds] = await Promise.all([
        tx.maintenanceJob.findMany({
          where: { status: { not: MaintenanceJobStatus.COMPLETE } },
          include: { asset: { select: { id: true, name: true } } },
        }),
        this.getBusyAssetIds(companyId),
      ]);

      const now = Date.now();
      const items: MaintenancePriorityItem[] = jobs.map((job) => {
        const ageDays = Math.floor((now - job.createdAt.getTime()) / DAY_MS);
        const currentlyInUse = busyAssetIds.has(job.assetId);
        const ageWeight = Math.min(ageDays, MAINTENANCE_AGE_WEIGHT_CAP_DAYS);
        const priorityScore = ageWeight + (currentlyInUse ? MAINTENANCE_IN_USE_BONUS : 0);

        const reasons: string[] = [];
        if (ageDays > 0) reasons.push(`Open ${ageDays} day${ageDays === 1 ? '' : 's'}.`);
        if (currentlyInUse) reasons.push('Asset is currently assigned to an open job.');
        if (reasons.length === 0) reasons.push('Recently reported.');

        return {
          maintenanceJobId: job.id,
          assetId: job.assetId,
          assetName: job.asset.name,
          title: job.title,
          ageDays,
          currentlyInUse,
          priorityScore,
          reasons,
        };
      });

      items.sort((a, b) => b.priorityScore - a.priorityScore);
      return items;
    });
  }

  private async getBusyAssetIds(companyId: string, excludeJobId?: string): Promise<Set<string>> {
    return this.prisma.withTenant(companyId, async (tx) => {
      const rows = await tx.job.findMany({
        where: {
          status: JobStatus.ASSIGNED,
          assetId: { not: null },
          ...(excludeJobId ? { id: { not: excludeJobId } } : {}),
        },
        select: { assetId: true },
      });
      return new Set(rows.map((r) => r.assetId!));
    });
  }
}
