import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { AddressBookEntryDto, CreateAddressBookDto, ImportAddressBookDto, UpdateAddressBookDto } from './dto/address-book.dto';

type Entry = AddressBookEntryDto;

/**
 * Depot/customer address books (Saved Layout): a named, savable snapshot of a
 * company's pickup depots and delivery customers. A multi-entity operator can
 * export a book from one company and import it into another — the book row
 * always lives in whichever company owns it, so RLS tenant isolation holds;
 * only the JSON payload of entries ever crosses the company boundary.
 */
@Injectable()
export class AddressBooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
  ) {}

  async findAll(companyId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const items = await tx.addressBook.findMany({ where: { archivedAt: null }, orderBy: { name: 'asc' } });
      return { items: items.map((b) => this.present(b)) };
    });
  }

  /** Save the current company's depots and/or customers into a named book. */
  async create(companyId: string, dto: CreateAddressBookDto) {
    const includeDepots = dto.includeDepots ?? true;
    const includeCustomers = dto.includeCustomers ?? true;
    if (!includeDepots && !includeCustomers) {
      throw new BadRequestException({ code: 'NOTHING_TO_SAVE', message: 'Include at least depots or customers.' });
    }
    return this.prisma.withTenant(companyId, async (tx) => {
      const entries: Entry[] = [];
      if (includeDepots) {
        const depots = await tx.depot.findMany({ where: { archivedAt: null }, orderBy: { name: 'asc' } });
        for (const d of depots) entries.push({ kind: 'depot', name: d.name, address: d.address ?? undefined, notes: d.notes ?? undefined });
      }
      if (includeCustomers) {
        const customers = await tx.customer.findMany({ where: { archivedAt: null }, orderBy: { name: 'asc' } });
        for (const c of customers)
          entries.push({ kind: 'customer', name: c.name, address: c.address ?? undefined, contactName: c.contactName ?? undefined, phone: c.phone ?? undefined, notes: c.notes ?? undefined });
      }
      const book = await tx.addressBook.create({ data: { companyId, name: dto.name.trim(), entries: entries as unknown as Prisma.InputJsonValue } });
      return this.present(book);
    });
  }

  async update(companyId: string, id: string, dto: UpdateAddressBookDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.require(tx, companyId, id);
      const book = await tx.addressBook.update({ where: { id }, data: { name: dto.name.trim() } });
      return this.present(book);
    });
  }

  async archive(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const book = await this.require(tx, companyId, id);
      if (book.archivedAt) return this.present(book);
      const archived = await tx.addressBook.update({ where: { id }, data: { archivedAt: new Date() } });
      return this.present(archived);
    });
  }

  /** The portable payload for transfer to another company. */
  async export(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const book = await this.require(tx, companyId, id);
      return { name: book.name, entries: this.entriesOf(book) };
    });
  }

  /** Import a portable payload as a new saved book in the current company. */
  async import(companyId: string, dto: ImportAddressBookDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const book = await tx.addressBook.create({ data: { companyId, name: dto.name.trim(), entries: dto.entries as unknown as Prisma.InputJsonValue } });
      return this.present(book);
    });
  }

  /**
   * Apply a book's entries into the current company's depots/customers,
   * idempotent by (kind, name): an entry whose name already exists is skipped,
   * so re-applying — or applying two overlapping books — never duplicates.
   */
  async apply(companyId: string, actorUserId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const book = await this.require(tx, companyId, id);
      const entries = this.entriesOf(book);

      const [existingDepots, existingCustomers] = await Promise.all([
        tx.depot.findMany({ where: {}, select: { name: true } }),
        tx.customer.findMany({ where: {}, select: { name: true } }),
      ]);
      const depotNames = new Set(existingDepots.map((d) => d.name.trim().toLowerCase()));
      const customerNames = new Set(existingCustomers.map((c) => c.name.trim().toLowerCase()));

      let depotsCreated = 0;
      let customersCreated = 0;
      let skipped = 0;
      for (const e of entries) {
        const key = e.name.trim().toLowerCase();
        if (e.kind === 'depot') {
          if (depotNames.has(key)) { skipped++; continue; }
          const depot = await tx.depot.create({ data: { companyId, name: e.name, address: e.address ?? null, notes: e.notes ?? null } });
          // Every entity gets a timeline event (CLAUDE.md) — a depot created by
          // applying an address book must be as traceable, with an actor, as one
          // typed in by hand. Creating these raw previously skipped both.
          await this.timeline.record(tx, {
            companyId,
            entityType: TimelineEntityType.DEPOT,
            entityId: depot.id,
            eventType: 'created',
            summary: `Depot "${depot.name}" created from address book "${book.name}".`,
            actorUserId,
          });
          depotNames.add(key);
          depotsCreated++;
        } else {
          if (customerNames.has(key)) { skipped++; continue; }
          const customer = await tx.customer.create({ data: { companyId, name: e.name, address: e.address ?? null, contactName: e.contactName ?? null, phone: e.phone ?? null, notes: e.notes ?? null } });
          await this.timeline.record(tx, {
            companyId,
            entityType: TimelineEntityType.CUSTOMER,
            entityId: customer.id,
            eventType: 'created',
            summary: `Customer "${customer.name}" created from address book "${book.name}".`,
            actorUserId,
          });
          customerNames.add(key);
          customersCreated++;
        }
      }
      return { depotsCreated, customersCreated, skipped };
    });
  }

  private entriesOf(book: { entries: Prisma.JsonValue }): Entry[] {
    return Array.isArray(book.entries) ? (book.entries as unknown as Entry[]) : [];
  }

  private present(book: { id: string; name: string; entries: Prisma.JsonValue; createdAt: Date; updatedAt: Date }) {
    const entries = this.entriesOf(book);
    return {
      id: book.id,
      name: book.name,
      depotCount: entries.filter((e) => e.kind === 'depot').length,
      customerCount: entries.filter((e) => e.kind === 'customer').length,
      entries,
      createdAt: book.createdAt,
      updatedAt: book.updatedAt,
    };
  }

  private async require(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const book = await tx.addressBook.findUnique({ where: { id } });
    if (!book || book.companyId !== companyId) {
      throw new NotFoundException({ code: 'ADDRESS_BOOK_NOT_FOUND', message: 'Address book not found.' });
    }
    return book;
  }
}
