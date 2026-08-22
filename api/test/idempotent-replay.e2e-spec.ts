/**
 * Idempotent-replay concurrency (audit Part 3). Four write paths — maintenance
 * job create, fuel entry create, message send, and customer match-or-create —
 * did a check-then-write on their idempotency key (clientRequestId, or the
 * customer's active-name) under READ COMMITTED, exactly the shape parcels
 * .scanParcel already learned to defend. Two concurrent requests carrying the
 * same key both read null and both inserted; the loser hit the unique index and
 * surfaced as an unhandled P2002 → 500, instead of the idempotent success it is.
 *
 * The real-world trigger is a DriverOS offline outbox replaying a queued write
 * at the same moment its original (lost-response) request finally lands, or a
 * double-tap: the caller must see one durable record, never a 500. Each test
 * fires the two writes with Promise.all against the real service + real Postgres
 * (RLS runtime role), asserting BOTH resolve to the SAME row and that exactly
 * one row exists — the loser is re-resolved to the winner, not a crash. Reverting
 * any service's P2002 catch turns its test from two-matching-ids into one
 * success + one rejected 500.
 *
 * Services are exercised directly (app.get) rather than over HTTP because
 * customers.findOrCreateByName is an internal match-or-create used by the stop
 * importer with no 1:1 route; calling the services keeps all four consistent and
 * still goes through withTenant + the real unique constraints.
 */
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { buildTestApp } from './utils/build-test-app';
import { createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { MaintenanceService } from '../src/maintenance/maintenance.service';
import { FuelService } from '../src/fuel/fuel.service';
import { MessagesService } from '../src/messages/messages.service';
import { CustomersService } from '../src/customers/customers.service';

const PERMS = [
  PERMISSIONS.MAINTENANCE_CREATE,
  PERMISSIONS.MAINTENANCE_VIEW,
  PERMISSIONS.FUEL_LOG,
  PERMISSIONS.MESSAGES_SEND,
  PERMISSIONS.CUSTOMERS_CREATE,
];

describe('Idempotent-replay concurrency (Part 3)', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();
  let maintenance: MaintenanceService;
  let fuel: FuelService;
  let messages: MessagesService;
  let customers: CustomersService;

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
    maintenance = app.get(MaintenanceService);
    fuel = app.get(FuelService);
    messages = app.get(MessagesService);
    customers = app.get(CustomersService);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await disconnectFixtures();
  });

  /** A committed race needs two settlements: allSettled so we can assert neither rejected. */
  async function race<T>(fire: () => Promise<T>): Promise<[PromiseSettledResult<T>, PromiseSettledResult<T>]> {
    const [a, b] = await Promise.allSettled([fire(), fire()]);
    return [a, b];
  }

  function expectBothSameRow<T extends { id: string }>(
    a: PromiseSettledResult<T>,
    b: PromiseSettledResult<T>,
  ): void {
    if (a.status !== 'fulfilled') throw new Error(`first call rejected: ${String((a as PromiseRejectedResult).reason)}`);
    if (b.status !== 'fulfilled') throw new Error(`second call rejected: ${String((b as PromiseRejectedResult).reason)}`);
    expect(a.value.id).toBe(b.value.id);
  }

  it('maintenance.create: two concurrent replays of the same clientRequestId open one job', async () => {
    const tenant = await createTestTenant(PERMS);
    const landClass = await prisma.assetClass.findFirstOrThrow({ where: { companyId: null, key: 'LAND' } });
    const asset = await prisma.asset.create({
      data: { companyId: tenant.companyId, name: 'Truck 1', assetClassId: landClass.id },
    });
    const clientRequestId = randomUUID();

    const [a, b] = await race(() =>
      maintenance.create(tenant.companyId, tenant.userId, {
        assetId: asset.id,
        title: 'Brake fault',
        description: 'Reported from the cab',
        clientRequestId,
      }),
    );

    expectBothSameRow(a, b);
    const rows = await prisma.maintenanceJob.findMany({ where: { companyId: tenant.companyId, clientRequestId } });
    expect(rows).toHaveLength(1);
  });

  it('fuel.create: two concurrent replays of the same clientRequestId record one entry', async () => {
    const tenant = await createTestTenant(PERMS);
    const clientRequestId = randomUUID();

    const [a, b] = await race(() =>
      fuel.create(tenant.companyId, tenant.userId, {
        odometerReading: 120345,
        licencePlate: 'ABC123',
        cardLast4: '1234',
        totalCost: 98.5,
        clientRequestId,
      }),
    );

    expectBothSameRow(a, b);
    const rows = await prisma.fuelEntry.findMany({ where: { companyId: tenant.companyId, clientRequestId } });
    expect(rows).toHaveLength(1);
  });

  it('messages.send: two concurrent replays of the same clientRequestId post one message', async () => {
    const tenant = await createTestTenant(PERMS);
    // Office user addresses a specific operator's thread; the operator row has no
    // login of its own, matching a real office → driver message.
    const operator = await prisma.operator.create({
      data: { companyId: tenant.companyId, fullName: 'Driver Dan' },
    });
    const clientRequestId = randomUUID();

    const [a, b] = await race(() =>
      messages.send(tenant.companyId, tenant.userId, {
        operatorId: operator.id,
        body: 'Head to the depot',
        clientRequestId,
      }),
    );

    expectBothSameRow(a, b);
    const rows = await prisma.message.findMany({ where: { companyId: tenant.companyId, clientRequestId } });
    expect(rows).toHaveLength(1);
  });

  it('customers.findOrCreateByName: two concurrent imports of the same name create one customer', async () => {
    const tenant = await createTestTenant(PERMS);
    const name = `Acme Logistics ${randomUUID()}`;

    const [a, b] = await race(() => customers.findOrCreateByName(tenant.companyId, tenant.userId, name));

    expectBothSameRow(a, b);
    const rows = await prisma.customer.findMany({
      where: { companyId: tenant.companyId, name, archivedAt: null },
    });
    expect(rows).toHaveLength(1);
  });
});
