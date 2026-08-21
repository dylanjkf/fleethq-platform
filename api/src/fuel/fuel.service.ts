import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { CreateFuelEntryDto, ListFuelEntriesDto } from './dto/fuel.dto';

/** Rows the office reads back, with the receipt as metadata only (never bytes inline). */
const FUEL_INCLUDE = {
  asset: { select: { id: true, name: true, registration: true } },
  operator: { select: { id: true, fullName: true } },
  receiptAttachment: { select: { id: true, filename: true, contentType: true, byteSize: true } },
} satisfies Prisma.FuelEntryInclude;

/**
 * Fuel-card purchases: a driver records what went into a vehicle from DriverOS
 * (odometer, receipt photo, card last-4, licence plate) and the office tracks
 * spend in FleetHQ.
 *
 * The receipt photo goes through AttachmentsService like a POD photo, so it
 * inherits the existing type allow-list, magic-byte sniffing, size caps and S3/
 * inline storage switch rather than introducing a second upload path.
 *
 * Card data: only `cardLast4` is ever accepted or stored — validated at the DTO
 * and again by a database CHECK. Nothing here logs it.
 */
@Injectable()
export class FuelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly attachments: AttachmentsService,
  ) {}

  async create(companyId: string, actorUserId: string, dto: CreateFuelEntryDto) {
    try {
      return await this.createInner(companyId, actorUserId, dto);
    } catch (err) {
      // Lost the idempotent-replay race: a concurrent request with the same
      // clientRequestId both read null and inserted — the loser hits the
      // [companyId, clientRequestId] unique constraint (P2002). Re-read and
      // return the winner (established pattern — parcels.scanParcel), so an
      // offline replay racing a live retry can't double-count fuel spend or 500.
      if (dto.clientRequestId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.withTenant(companyId, (tx) =>
          tx.fuelEntry.findFirst({ where: { companyId, clientRequestId: dto.clientRequestId }, include: FUEL_INCLUDE }),
        );
        if (existing) return existing;
      }
      throw err;
    }
  }

  private async createInner(companyId: string, actorUserId: string, dto: CreateFuelEntryDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      // Idempotent replay: a DriverOS fuel entry queued offline and re-sent after
      // a lost response carries a stable clientRequestId — return the existing
      // entry rather than double-counting it in the office spend rollup.
      if (dto.clientRequestId) {
        const existing = await tx.fuelEntry.findFirst({
          where: { companyId, clientRequestId: dto.clientRequestId },
          include: FUEL_INCLUDE,
        });
        if (existing) return existing;
      }

      if (dto.assetId) {
        const asset = await tx.asset.findFirst({ where: { id: dto.assetId, companyId } });
        if (!asset) throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: 'Asset not found.' });
      }

      // A DriverOS caller is an operator; an office user recording on someone's
      // behalf simply has no operator row, which is fine — the entry still stands.
      const operator = await tx.operator.findFirst({
        where: { userId: actorUserId, archivedAt: null },
        select: { id: true },
      });

      let receiptAttachmentId: string | undefined;
      if (dto.receiptBase64) {
        const att = await this.attachments.createInTx(tx, companyId, actorUserId, {
          filename: dto.receiptFilename ?? 'fuel-receipt.jpg',
          contentType: dto.receiptContentType ?? 'image/jpeg',
          dataBase64: dto.receiptBase64,
        });
        receiptAttachmentId = att.id;
      }

      const entry = await tx.fuelEntry.create({
        data: {
          companyId,
          assetId: dto.assetId ?? null,
          operatorId: operator?.id ?? null,
          receiptAttachmentId,
          odometerReading: dto.odometerReading,
          licencePlate: dto.licencePlate.trim().toUpperCase(),
          cardLast4: dto.cardLast4,
          litres: dto.litres ?? null,
          totalCost: dto.totalCost ?? null,
          filledAt: dto.filledAt ? new Date(dto.filledAt) : new Date(),
          notes: dto.notes?.trim() || null,
          clientRequestId: dto.clientRequestId ?? null,
        },
        include: FUEL_INCLUDE,
      });

      // Fuel is asset history — it belongs on the asset's timeline when we know
      // which asset it was, so a vehicle's record shows its refuels alongside its
      // faults and services. Only the last 4 of the card is ever written here.
      if (entry.assetId) {
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.ASSET,
          entityId: entry.assetId,
          eventType: 'fuel_recorded',
          summary: `Fuel recorded at ${entry.odometerReading} km${entry.totalCost ? ` — $${entry.totalCost}` : ''}.`,
          payload: {
            fuelEntryId: entry.id,
            odometerReading: entry.odometerReading,
            litres: entry.litres,
            totalCost: entry.totalCost,
            cardLast4: entry.cardLast4,
          },
          actorUserId,
        });
      }

      return entry;
    });
  }

  async findAll(companyId: string, query: ListFuelEntriesDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const where: Prisma.FuelEntryWhereInput = query.assetId ? { assetId: query.assetId } : {};
      const [items, total] = await Promise.all([
        tx.fuelEntry.findMany({
          where,
          include: FUEL_INCLUDE,
          orderBy: { filledAt: 'desc' },
          skip: query.skip,
          take: query.take,
        }),
        tx.fuelEntry.count({ where }),
      ]);
      return { items, total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  /**
   * Spend rollup for the office. Aggregated in SQL rather than by summing a
   * fetched page, so the totals stay correct (and cheap) as the log grows past
   * one page.
   */
  async summary(companyId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const agg = await tx.fuelEntry.aggregate({
        _sum: { totalCost: true, litres: true },
        _count: { _all: true },
      });
      return {
        entryCount: agg._count._all,
        totalCost: agg._sum.totalCost ?? null,
        totalLitres: agg._sum.litres ?? null,
      };
    });
  }
}
