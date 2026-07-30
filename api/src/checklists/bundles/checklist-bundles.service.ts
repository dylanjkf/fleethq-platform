import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateChecklistBundleDto, DeployChecklistBundleDto, UpdateChecklistBundleDto } from './dto/checklist-bundle.dto';

const TEMPLATE_SELECT = { id: true, name: true, version: true, appliesToAssetClassId: true } as const;

/**
 * Checklist/inspection bundles (Saved Layout): a named group of checklist
 * templates. Deploying a bundle scopes every member template to the chosen
 * asset class in one action — so a whole pre-start / inspection set lands on
 * (say) every LAND asset at once, instead of re-scoping each template by hand.
 */
@Injectable()
export class ChecklistBundlesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(companyId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const items = await tx.checklistBundle.findMany({
        where: { archivedAt: null },
        orderBy: [{ name: 'asc' }],
        include: { items: { include: { template: { select: TEMPLATE_SELECT } } } },
      });
      return {
        items: items.map((b) => ({
          id: b.id,
          name: b.name,
          description: b.description,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
          templates: b.items.map((i) => i.template),
        })),
      };
    });
  }

  async create(companyId: string, dto: CreateChecklistBundleDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.assertTemplatesExist(tx, companyId, dto.templateIds);
      const bundle = await tx.checklistBundle.create({
        data: { companyId, name: dto.name.trim(), description: dto.description?.trim() || null },
      });
      await tx.checklistBundleItem.createMany({
        data: dto.templateIds.map((templateId) => ({ companyId, bundleId: bundle.id, templateId })),
        skipDuplicates: true,
      });
      return this.getOne(tx, bundle.id);
    });
  }

  async update(companyId: string, id: string, dto: UpdateChecklistBundleDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.require(tx, companyId, id);
      await tx.checklistBundle.update({
        where: { id },
        data: { name: dto.name?.trim(), description: dto.description === undefined ? undefined : dto.description.trim() || null },
      });
      if (dto.templateIds) {
        await this.assertTemplatesExist(tx, companyId, dto.templateIds);
        // Replace the membership set.
        await tx.checklistBundleItem.deleteMany({ where: { bundleId: id } });
        await tx.checklistBundleItem.createMany({
          data: dto.templateIds.map((templateId) => ({ companyId, bundleId: id, templateId })),
          skipDuplicates: true,
        });
      }
      return this.getOne(tx, id);
    });
  }

  async archive(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const bundle = await this.require(tx, companyId, id);
      if (bundle.archivedAt) return this.getOne(tx, id);
      await tx.checklistBundle.update({ where: { id }, data: { archivedAt: new Date() } });
      return this.getOne(tx, id);
    });
  }

  /** Deploy: scope every template in the bundle to the given asset class. */
  async deploy(companyId: string, id: string, dto: DeployChecklistBundleDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.require(tx, companyId, id);
      const assetClass = await tx.assetClass.findFirst({ where: { key: dto.assetClass, archivedAt: null }, orderBy: { companyId: 'asc' } });
      if (!assetClass) throw new BadRequestException({ code: 'ASSET_CLASS_NOT_FOUND', message: 'Asset category not found.' });
      const templateIds = (await tx.checklistBundleItem.findMany({ where: { bundleId: id }, select: { templateId: true } })).map((i) => i.templateId);
      if (templateIds.length === 0) return { scoped: 0, assetClass: dto.assetClass };
      const res = await tx.checklistTemplate.updateMany({
        where: { id: { in: templateIds }, companyId, archivedAt: null },
        data: { appliesToAssetClassId: assetClass.id },
      });
      return { scoped: res.count, assetClass: dto.assetClass };
    });
  }

  private async getOne(tx: Prisma.TransactionClient, id: string) {
    const b = await tx.checklistBundle.findUniqueOrThrow({
      where: { id },
      include: { items: { include: { template: { select: TEMPLATE_SELECT } } } },
    });
    return { id: b.id, name: b.name, description: b.description, createdAt: b.createdAt, updatedAt: b.updatedAt, templates: b.items.map((i) => i.template) };
  }

  private async assertTemplatesExist(tx: Prisma.TransactionClient, companyId: string, templateIds: string[]) {
    const found = await tx.checklistTemplate.count({ where: { id: { in: templateIds }, companyId, archivedAt: null } });
    if (found !== new Set(templateIds).size) {
      throw new BadRequestException({ code: 'TEMPLATE_NOT_FOUND', message: 'One or more checklist templates were not found.' });
    }
  }

  private async require(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const bundle = await tx.checklistBundle.findUnique({ where: { id } });
    if (!bundle || bundle.companyId !== companyId) {
      throw new NotFoundException({ code: 'CHECKLIST_BUNDLE_NOT_FOUND', message: 'Checklist bundle not found.' });
    }
    return bundle;
  }
}
