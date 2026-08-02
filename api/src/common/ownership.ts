import { NotFoundException } from '@nestjs/common';

/**
 * The minimal structural shape a row must have for a tenant-ownership check:
 * a `companyId` to match against the caller's tenant, and an optional
 * `archivedAt` soft-delete marker. Every registry model satisfies this.
 */
export interface OwnableRecord {
  companyId: string;
  archivedAt?: Date | null;
}

/**
 * The minimal structural slice of a Prisma model delegate this helper needs:
 * a `findUnique` that resolves a row (or `null`) by id. Every tenant-scoped
 * delegate off a transaction client — `tx.asset`, `tx.formTemplate`,
 * `tx.operator`, `tx.attachedUnit`, … — satisfies it, so callers pass the
 * delegate directly (`tx.asset`) rather than an injected service. Taking a
 * delegate rather than a sibling service is deliberate: it keeps the check a
 * pure function of (delegate, id, companyId) and sidesteps the module-level
 * circular-dependency problem that a cross-injected ownership service creates.
 */
export interface OwnableDelegate<T extends OwnableRecord> {
  findUnique(args: { where: { id: string } }): Promise<T | null>;
}

export interface AssertOwnershipOptions {
  /** Machine-readable error code thrown on a miss (e.g. `ASSET_NOT_FOUND`). */
  code: string;
  /** Human-readable message thrown on a miss. */
  message: string;
  /**
   * When `false` (the default), an archived row is treated as not found — the
   * same 404 a genuinely missing / cross-tenant row gets, so a caller that must
   * refuse retired entities (filing a document against a scrapped asset) needs
   * no second lookup. When `true`, archived rows pass the check (update/archive
   * and read-history callers that legitimately act on archived rows).
   */
  allowArchived?: boolean;
}

/**
 * Stateless tenant-ownership guard shared across services. Loads `id` via the
 * given delegate and throws a `NotFoundException` (never revealing existence of
 * another tenant's row) when the row is missing, belongs to a different
 * company, or — unless `allowArchived` — is archived. Returns the loaded row so
 * callers that need its fields don't re-query.
 */
export async function assertOwnership<T extends OwnableRecord>(
  delegate: OwnableDelegate<T>,
  id: string,
  companyId: string,
  { code, message, allowArchived = false }: AssertOwnershipOptions,
): Promise<T> {
  const record = await delegate.findUnique({ where: { id } });
  if (!record || record.companyId !== companyId || (!allowArchived && record.archivedAt)) {
    throw new NotFoundException({ code, message });
  }
  return record;
}
