import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

/**
 * The fleet's own directory of who it delivers to (01-Product roadmap, courier
 * vertical per 00-Company/Commercial_Priority.md): a saved name/address/contact
 * so a delivery stop references a Customer instead of the office retyping the
 * same address every day. Internal directory only — no customer login or
 * portal (CLAUDE.md scope). Mirrors the AttachedUnit reference-record pattern.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
  ) {}

  // actorUserId is optional so the Integration Sync Engine can create rows for
  // a SCHEDULED/webhook-triggered sync (no human in the loop) via this exact
  // path — TimelineService already attributes an absent actor to SYSTEM.
  async create(companyId: string, actorUserId: string | undefined, dto: CreateCustomerDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const customer = await tx.customer.create({
        data: {
          companyId,
          name: dto.name,
          address: dto.address,
          contactName: dto.contactName,
          phone: dto.phone,
          notes: dto.notes,
        },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.CUSTOMER,
        entityId: customer.id,
        eventType: 'created',
        summary: `Customer "${customer.name}" created.`,
        actorUserId,
      });

      return customer;
    });
  }

  async findAll(companyId: string, query: ListQueryDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const term = query.searchTerm;
      const where: Prisma.CustomerWhereInput = {
        ...(query.includeArchived ? {} : { archivedAt: null }),
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { contactName: { contains: term, mode: 'insensitive' } },
                { phone: { contains: term, mode: 'insensitive' } },
                { address: { contains: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        tx.customer.findMany({
          where,
          orderBy: { name: 'asc' },
          skip: query.skip,
          take: query.take,
        }),
        tx.customer.count({ where }),
      ]);
      return { items, total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async findOne(companyId: string, id: string) {
    const customer = await this.prisma.withTenant(companyId, (tx) => tx.customer.findUnique({ where: { id } }));
    if (!customer || customer.companyId !== companyId) {
      throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' });
    }
    return customer;
  }

  /**
   * A customer's logged delivery history — every stop that has ever referenced
   * this customer, newest first, with its outcome and proof. Zero duplicate
   * data entry: this is derived from the existing JobStop records, not a second
   * copy. Terminal stops (delivered/failed) are the "past deliveries"; pending
   * ones are surfaced too so the office sees what's still in flight for them.
   */
  async deliveries(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireCustomer(tx, companyId, id);
      const stops = await tx.jobStop.findMany({
        where: { customerId: id },
        orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
        take: 200,
        select: {
          id: true,
          label: true,
          address: true,
          outcome: true,
          failureReason: true,
          completedAt: true,
          recipientName: true,
          note: true,
          windowEnd: true,
          podAttachmentId: true,
          signatureAttachmentId: true,
          createdAt: true,
          job: { select: { id: true, title: true } },
        },
      });
      return {
        summary: {
          total: stops.length,
          delivered: stops.filter((s) => s.outcome === 'DELIVERED').length,
          failed: stops.filter((s) => s.outcome === 'FAILED').length,
          pending: stops.filter((s) => s.outcome === 'PENDING').length,
        },
        items: stops,
      };
    });
  }

  async update(companyId: string, actorUserId: string, id: string, dto: UpdateCustomerDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireCustomer(tx, companyId, id);

      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const field of ['name', 'address', 'contactName', 'phone', 'notes'] as const) {
        if (dto[field] !== undefined && dto[field] !== existing[field]) {
          changed[field] = { from: existing[field], to: dto[field] };
        }
      }

      const customer = await tx.customer.update({
        where: { id },
        data: {
          name: dto.name,
          address: dto.address,
          contactName: dto.contactName,
          phone: dto.phone,
          notes: dto.notes,
        },
      });

      if (Object.keys(changed).length > 0) {
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.CUSTOMER,
          entityId: customer.id,
          eventType: 'updated',
          summary: `Customer "${customer.name}" updated.`,
          payload: changed,
          actorUserId,
        });
      }

      return customer;
    });
  }

  async archive(companyId: string, actorUserId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireCustomer(tx, companyId, id);
      if (existing.archivedAt) return existing;

      const customer = await tx.customer.update({ where: { id }, data: { archivedAt: new Date() } });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.CUSTOMER,
        entityId: customer.id,
        eventType: 'archived',
        summary: `Customer "${customer.name}" archived.`,
        actorUserId,
      });

      return customer;
    });
  }

  async requireCustomer(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const customer = await tx.customer.findUnique({ where: { id } });
    if (!customer || customer.companyId !== companyId) {
      throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found.' });
    }
    return customer;
  }

  /** Finds an active customer by exact (case-insensitive) name — used by the stop-import matcher. */
  async findByName(tx: Prisma.TransactionClient, companyId: string, name: string) {
    return tx.customer.findFirst({
      where: { companyId, archivedAt: null, name: { equals: name, mode: 'insensitive' } },
    });
  }

  /**
   * Matches an existing active customer by name, or creates one — the manifest
   * import's "match or create as you go" behavior, so a dispatcher never has to
   * pre-populate the address book before importing a new customer's stop.
   * Deliberately does not overwrite an existing customer's saved details from
   * a manifest row: a saved address book entry is the trusted source once it
   * exists, only genuinely new customers get created from import data.
   */
  async findOrCreateByName(
    companyId: string,
    actorUserId: string,
    name: string,
    address?: string,
    contactName?: string,
  ) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.findByName(tx, companyId, name);
      if (existing) return existing;

      const customer = await tx.customer.create({ data: { companyId, name, address, contactName } });
      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.CUSTOMER,
        entityId: customer.id,
        eventType: 'created',
        summary: `Customer "${customer.name}" created from a stop import.`,
        actorUserId,
      });
      return customer;
    });
  }

  /**
   * Natural-key upsert used by the CSV bulk-import / Integration Sync path: an
   * incoming row whose (case-insensitive) name already matches a live customer
   * is treated as that existing customer rather than inserted again, so
   * re-importing the same directory is idempotent (the audit found re-imports
   * duplicated every row). A genuinely new name is created exactly as `create()`
   * would (same write + Timeline event). The `customers_company_id_name_active_key`
   * partial-unique index (migration 20260801100000) is the race-safe backstop:
   * a concurrent insert that wins the same name surfaces as P2002, which is
   * re-resolved to the now-existing row. `created` lets the importer report an
   * insert vs. a de-dup skip without a new result field.
   */
  async importByName(
    companyId: string,
    actorUserId: string | undefined,
    dto: CreateCustomerDto,
  ): Promise<{ id: string; created: boolean }> {
    const existing = await this.prisma.withTenant(companyId, (tx) => this.findByName(tx, companyId, dto.name));
    if (existing) return { id: existing.id, created: false };
    try {
      const customer = await this.create(companyId, actorUserId, dto);
      return { id: customer.id, created: true };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.prisma.withTenant(companyId, (tx) => this.findByName(tx, companyId, dto.name));
        if (raced) return { id: raced.id, created: false };
      }
      throw err;
    }
  }
}
