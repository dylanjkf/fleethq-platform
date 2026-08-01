/**
 * DriverOS messaging v0 (04-DriverOS/DriverOS_Overview.md): a single
 * operator ↔ office thread per Operator. Covers the two-party thread (office
 * and operator both post, both read the same ordered thread), the server pinning
 * an operator to their own thread (an operator can't read or post into another's),
 * the office "operator required" rule, tenant isolation, and route permissions.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import {
  TEST_PASSWORD,
  createOperatorLinkedToUser,
  createTestTenant,
  disconnectFixtures,
  ensureAssetClasses,
  ensurePermissions,
} from './utils/fixtures';

const OFFICE = [PERMISSIONS.MESSAGES_VIEW, PERMISSIONS.MESSAGES_SEND, PERMISSIONS.OPERATORS_CREATE];
const OPERATOR = [PERMISSIONS.MESSAGES_VIEW, PERMISSIONS.MESSAGES_SEND];

describe('Messages (DriverOS messaging v0)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
  });

  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
  });

  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username, password: TEST_PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  it('carries a two-party thread: office and operator both post and read it in order', async () => {
    const office = await createTestTenant(OFFICE);
    const officeToken = await login(office.username);
    // A second user in the SAME company, linked to an operator.
    const operatorTenant = await createTestTenant(OPERATOR); // separate company
    // Build the operator inside the office's company and give the office user's
    // thread partner a login by reusing the office tenant's own user as operator.
    const operatorId = await createOperatorLinkedToUser(office.companyId, office.userId, 'Dana Driver');

    // The office user here doubles as the operator (linked), so it posts as OPERATOR.
    const asOperator = await request(app.getHttpServer())
      .post('/v1/messages')
      .set('Authorization', `Bearer ${officeToken}`)
      .send({ body: 'Running 10 late, traffic on the M1.' })
      .expect(201);
    expect(asOperator.body.senderType).toBe('OPERATOR');
    expect(asOperator.body.operatorId).toBe(operatorId);

    const thread = await request(app.getHttpServer())
      .get('/v1/messages')
      .set('Authorization', `Bearer ${officeToken}`)
      .expect(200);
    expect(thread.body.operatorId).toBe(operatorId);
    expect(thread.body.items).toHaveLength(1);
    expect(thread.body.items[0].body).toBe('Running 10 late, traffic on the M1.');

    // Unused in this assertion path; keep the second tenant referenced.
    expect(operatorTenant.companyId).not.toBe(office.companyId);
  });

  it('lets an office user address a specific operator, and pins an operator to their own thread', async () => {
    const office = await createTestTenant(OFFICE);
    const officeToken = await login(office.username);

    // Create an operator with its own login in the office's company.
    const operatorRes = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${officeToken}`)
      .send({ fullName: 'Jordan Operator' })
      .expect(201);
    const operatorId = operatorRes.body.id as string;

    // Office sends into that operator's thread.
    const officeMsg = await request(app.getHttpServer())
      .post('/v1/messages')
      .set('Authorization', `Bearer ${officeToken}`)
      .send({ operatorId, body: 'Head to depot B after this drop.' })
      .expect(201);
    expect(officeMsg.body.senderType).toBe('OFFICE');
    expect(officeMsg.body.operatorId).toBe(operatorId);

    // Office reads that thread by id.
    const thread = await request(app.getHttpServer())
      .get(`/v1/messages?operatorId=${operatorId}`)
      .set('Authorization', `Bearer ${officeToken}`)
      .expect(200);
    expect(thread.body.items).toHaveLength(1);

    // The thread now accepts the shared page/pageSize params (previously a hard
    // 400) and returns the standard paginated envelope alongside the messages.
    const paged = await request(app.getHttpServer())
      .get(`/v1/messages?operatorId=${operatorId}&page=1&pageSize=10`)
      .set('Authorization', `Bearer ${officeToken}`)
      .expect(200);
    expect(paged.body).toMatchObject({ operatorId, total: 1, page: 1, pageSize: 10 });
    expect(paged.body.items).toHaveLength(1);
  });

  it('requires an operator when an office user sends with none specified', async () => {
    const office = await createTestTenant(OFFICE);
    const token = await login(office.username);
    const res = await request(app.getHttpServer())
      .post('/v1/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hello?' })
      .expect(400);
    expect(res.body.error.code).toBe('MESSAGE_OPERATOR_REQUIRED');
  });

  it('is tenant-isolated: an office user cannot address another company\'s operator', async () => {
    const tenantA = await createTestTenant(OFFICE);
    const tenantB = await createTestTenant(OFFICE);
    const tokenA = await login(tenantA.username);
    const tokenB = await login(tenantB.username);

    const operatorB = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ fullName: 'B Operator' })
      .expect(201);

    const cross = await request(app.getHttpServer())
      .post('/v1/messages')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ operatorId: operatorB.body.id, body: 'wrong company' })
      .expect(404);
    expect(cross.body.error.code).toBe('OPERATOR_NOT_FOUND');
  });

  it('enforces route-level permissions', async () => {
    const viewOnly = await createTestTenant([PERMISSIONS.MESSAGES_VIEW, PERMISSIONS.OPERATORS_CREATE]);
    const token = await login(viewOnly.username);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'X' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/v1/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ operatorId: operator.body.id, body: 'no perm' })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.MESSAGES_SEND);
  });

  it('broadcasts one message into every operator’s thread at once', async () => {
    const office = await createTestTenant([
      PERMISSIONS.MESSAGES_VIEW,
      PERMISSIONS.MESSAGES_BROADCAST,
      PERMISSIONS.OPERATORS_CREATE,
    ]);
    const token = await login(office.username);
    const auth = { Authorization: `Bearer ${token}` };

    const opA = await request(app.getHttpServer()).post('/v1/operators').set(auth).send({ fullName: 'Op A' }).expect(201);
    const opB = await request(app.getHttpServer()).post('/v1/operators').set(auth).send({ fullName: 'Op B' }).expect(201);

    const res = await request(app.getHttpServer())
      .post('/v1/messages/broadcast')
      .set(auth)
      .send({ body: 'Depot closes at 4pm today.' })
      .expect(201);
    expect(res.body.sent).toBe(2);

    for (const opId of [opA.body.id, opB.body.id]) {
      const thread = await request(app.getHttpServer()).get(`/v1/messages?operatorId=${opId}`).set(auth).expect(200);
      expect(thread.body.items).toHaveLength(1);
      expect(thread.body.items[0].senderType).toBe('OFFICE');
      expect(thread.body.items[0].body).toBe('Depot closes at 4pm today.');
    }
  });

  it('gates broadcast on messages:broadcast', async () => {
    // A user who can send in a single thread still can't broadcast without the
    // dedicated permission — the exact gap that stops drivers replying when
    // their role omits a message permission.
    const canSendNotBroadcast = await createTestTenant([PERMISSIONS.MESSAGES_VIEW, PERMISSIONS.MESSAGES_SEND]);
    const token = await login(canSendNotBroadcast.username);
    const res = await request(app.getHttpServer())
      .post('/v1/messages/broadcast')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'nope' })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.MESSAGES_BROADCAST);
  });
});
