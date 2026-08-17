import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AddParcelsDto, ScanParcelDto } from './dto/parcels.dto';

/**
 * Parcels within a delivery stop (05-Dispatch: multi-parcel courier runs).
 * The office pre-lists a stop's parcels (from a manifest); the driver scans
 * each on DriverOS to mark it handled — including a parcel that wasn't on the
 * manifest, which `scan` adds on the fly. Optional per stop: a stop with no
 * parcels is unchanged.
 */
@Injectable()
export class ParcelsService {
  constructor(private readonly prisma: PrismaService) {}

  async getParcels(companyId: string, jobId: string, stopId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireStop(tx, companyId, jobId, stopId);
      return this.listParcels(tx, stopId);
    });
  }

  async addParcels(companyId: string, jobId: string, stopId: string, dto: AddParcelsDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireStop(tx, companyId, jobId, stopId);
      await tx.stopParcel.createMany({
        data: dto.parcels.map((p) => ({ companyId, stopId, reference: p.reference, label: p.label ?? null })),
        skipDuplicates: true, // re-adding an existing reference on this stop is a no-op
      });
      return this.listParcels(tx, stopId);
    });
  }

  /**
   * Marks a parcel scanned. Idempotent, and forgiving: an unknown reference is
   * created already-scanned (a driver scanning a parcel the office didn't list),
   * an already-scanned one is left as-is rather than re-stamped.
   *
   * The find-then-create is a check-then-write racing on `@@unique([stopId,
   * reference])`: two concurrent scans of the SAME new reference (a driver
   * double-tap, or an offline outbox replay racing a live retry) both read null
   * and both insert — one wins, the loser hits P2002. Rather than escalate the
   * whole path to SERIALIZABLE for one constrained insert, catch that P2002 (the
   * established pattern across ~a dozen services here — companies, users, depots,
   * assets, webauthn) and treat it as the idempotent success it is: the winner
   * already created the row, so re-read and return it. The desired end state
   * (parcel exists, scanned) holds either way, so no unhandled 500.
   */
  async scanParcel(companyId: string, jobId: string, stopId: string, dto: ScanParcelDto) {
    try {
      return await this.prisma.withTenant(companyId, async (tx) => {
        await this.requireStop(tx, companyId, jobId, stopId);
        const existing = await tx.stopParcel.findUnique({
          where: { stopId_reference: { stopId, reference: dto.reference } },
        });
        if (existing) {
          if (!existing.scannedAt) {
            await tx.stopParcel.update({ where: { id: existing.id }, data: { scannedAt: new Date() } });
          }
        } else {
          await tx.stopParcel.create({ data: { companyId, stopId, reference: dto.reference, scannedAt: new Date() } });
        }
        return this.listParcels(tx, stopId);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Lost the create race — the concurrent scan already inserted the parcel
        // (scanned). Re-read in a fresh transaction and return the settled state.
        return this.prisma.withTenant(companyId, async (tx) => {
          await this.requireStop(tx, companyId, jobId, stopId);
          return this.listParcels(tx, stopId);
        });
      }
      throw err;
    }
  }

  private async requireStop(tx: Prisma.TransactionClient, companyId: string, jobId: string, stopId: string) {
    const stop = await tx.jobStop.findFirst({ where: { id: stopId, jobId, job: { companyId } }, select: { id: true } });
    if (!stop) {
      throw new NotFoundException({ code: 'STOP_NOT_FOUND', message: 'Delivery stop not found.' });
    }
    return stop;
  }

  private async listParcels(tx: Prisma.TransactionClient, stopId: string) {
    const parcels = await tx.stopParcel.findMany({ where: { stopId }, orderBy: { createdAt: 'asc' } });
    const scanned = parcels.filter((p) => p.scannedAt).length;
    return { parcels, scanned, total: parcels.length };
  }
}
