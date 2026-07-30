import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAssetClassDto, UpdateAssetClassDto } from './dto/asset-class.dto';

/** Turns a display name into a stable, comparable key: "Reefer Truck" -> "REEFER_TRUCK". */
function slugKey(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

/**
 * Asset categories. The built-ins (Land/Air/Sea, companyId = null) are shared
 * rows every tenant reads; a company can add its own categories — each usable by
 * checklists/inspections. RLS scopes reads to "built-ins + own" and writes to
 * "own", so one company can never see or touch another's categories.
 *
 * **Removing a category** works two different ways, because the two kinds of row
 * are not equivalent:
 *  - a company's **own** category is archived on its own record (`archivedAt`);
 *  - a shared **built-in** cannot be archived — that would remove it for every
 *    tenant — so it is *suppressed per company* via `HiddenAssetClass`, and can
 *    be restored by deleting that row. Both paths refuse while assets still use
 *    the category, so removing one can never orphan an asset.
 */
@Injectable()
export class AssetClassesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Built-ins (minus ones this company removed) + this company's own, non-archived. */
  async findAll(companyId: string, options: { includeHidden?: boolean } = {}) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const [items, hidden] = await Promise.all([
        tx.assetClass.findMany({
          where: { archivedAt: null },
          orderBy: [{ companyId: 'asc' }, { name: 'asc' }],
          select: { id: true, key: true, name: true, description: true, companyId: true },
        }),
        tx.hiddenAssetClass.findMany({ select: { assetClassId: true } }),
      ]);
      const hiddenIds = new Set(hidden.map((h) => h.assetClassId));
      const mapped = items.map((c) => ({
        id: c.id,
        key: c.key,
        name: c.name,
        description: c.description,
        isBuiltIn: c.companyId === null,
        isHidden: hiddenIds.has(c.id),
      }));
      // Callers picking a category for an asset must not see removed ones;
      // the settings screen passes includeHidden so it can offer "restore".
      return { items: options.includeHidden ? mapped : mapped.filter((c) => !c.isHidden) };
    });
  }

  /**
   * Remove a category from this company. Archives an own category; suppresses a
   * built-in (idempotently) rather than archiving the shared row.
   */
  async remove(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const found = await tx.assetClass.findUnique({ where: { id } });
      if (!found || (found.companyId !== null && found.companyId !== companyId)) {
        throw new NotFoundException({ code: 'ASSET_CLASS_NOT_FOUND', message: 'Asset category not found.' });
      }
      await this.assertNotInUse(tx, id);

      if (found.companyId === null) {
        // Shared built-in: hide it for this company only. upsert keeps a repeated
        // remove a no-op rather than a unique-constraint error.
        await tx.hiddenAssetClass.upsert({
          where: { companyId_assetClassId: { companyId, assetClassId: id } },
          create: { companyId, assetClassId: id },
          update: {},
        });
        return { id, removed: 'hidden' as const };
      }

      if (!found.archivedAt) await tx.assetClass.update({ where: { id }, data: { archivedAt: new Date() } });
      return { id, removed: 'archived' as const };
    });
  }

  /** Bring a removed built-in back for this company. */
  async restore(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const found = await tx.assetClass.findUnique({ where: { id } });
      if (!found) throw new NotFoundException({ code: 'ASSET_CLASS_NOT_FOUND', message: 'Asset category not found.' });

      if (found.companyId === null) {
        await tx.hiddenAssetClass.deleteMany({ where: { companyId, assetClassId: id } });
        return { id, restored: true };
      }
      if (found.companyId !== companyId) {
        throw new NotFoundException({ code: 'ASSET_CLASS_NOT_FOUND', message: 'Asset category not found.' });
      }
      await tx.assetClass.update({ where: { id }, data: { archivedAt: null } });
      return { id, restored: true };
    });
  }

  /** Removing a category must never orphan an asset that still points at it. */
  private async assertNotInUse(tx: Prisma.TransactionClient, assetClassId: string) {
    const inUse = await tx.asset.count({ where: { assetClassId, archivedAt: null } });
    if (inUse > 0) {
      throw new BadRequestException({
        code: 'ASSET_CLASS_IN_USE',
        message: `Move the ${inUse} asset(s) in this category to another category first.`,
      });
    }
  }

  async create(companyId: string, dto: CreateAssetClassDto) {
    const key = slugKey(dto.name);
    if (!key) throw new BadRequestException({ code: 'INVALID_NAME', message: 'A category name with letters or numbers is required.' });
    return this.prisma.withTenant(companyId, async (tx) => {
      // Reject a clash with a visible category (built-in or own) of the same key.
      const clash = await tx.assetClass.findFirst({ where: { key, archivedAt: null } });
      if (clash) throw new BadRequestException({ code: 'ASSET_CLASS_EXISTS', message: 'A category with a similar name already exists.' });
      const created = await tx.assetClass.create({
        data: { companyId, key, name: dto.name.trim(), description: dto.description?.trim() || null },
      });
      return { id: created.id, key: created.key, name: created.name, description: created.description, isBuiltIn: false };
    });
  }

  async update(companyId: string, id: string, dto: UpdateAssetClassDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireOwn(tx, companyId, id);
      const updated = await tx.assetClass.update({
        where: { id: existing.id },
        data: { name: dto.name?.trim(), description: dto.description === undefined ? undefined : dto.description.trim() || null },
      });
      return { id: updated.id, key: updated.key, name: updated.name, description: updated.description, isBuiltIn: false };
    });
  }

  /** A category this company owns (never a built-in, never another company's — RLS + explicit check). */
  private async requireOwn(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const found = await tx.assetClass.findUnique({ where: { id } });
    if (!found || found.companyId !== companyId) {
      throw new NotFoundException({ code: 'ASSET_CLASS_NOT_FOUND', message: 'Custom asset category not found.' });
    }
    return found;
  }
}
