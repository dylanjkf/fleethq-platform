/**
 * Integration Hub: credential vault, connections + field mappings, the CSV
 * reference connector's manual sync (reusing the bulk `imports` module's real
 * Customer/Depot create paths), dead-letter handling for a bad row, the
 * incoming webhook receiver's signature check, and permission enforcement.
 */
import { createHmac } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const MANAGER = [PERMISSIONS.INTEGRATIONS_VIEW, PERMISSIONS.INTEGRATIONS_MANAGE, PERMISSIONS.CUSTOMERS_VIEW];

describe('Integration Hub', () => {
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
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  it('creates and lists credentials without ever exposing the encrypted secret material', async () => {
    const tenant = await createTestTenant(MANAGER);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    const created = await request(app.getHttpServer())
      .post('/v1/integrations/credentials')
      .set(auth)
      .send({ name: 'ERP API key', authType: 'API_KEY', secretValue: 'super-secret-value' })
      .expect(201);
    expect(created.body.name).toBe('ERP API key');
    expect(created.body.authType).toBe('API_KEY');
    expect(created.body.encryptedPayload).toBeUndefined();
    expect(created.body.encryptionIv).toBeUndefined();
    expect(created.body.encryptionTag).toBeUndefined();
    expect(JSON.stringify(created.body)).not.toContain('super-secret-value');

    const list = await request(app.getHttpServer()).get('/v1/integrations/credentials').set(auth).expect(200);
    expect(list.body.items.map((c: { id: string }) => c.id)).toContain(created.body.id);
    for (const item of list.body.items) {
      expect(item.encryptedPayload).toBeUndefined();
      expect(item.encryptionIv).toBeUndefined();
      expect(item.encryptionTag).toBeUndefined();
    }

    // The credential "test" is a decrypt round-trip, not a real external call.
    const testResult = await request(app.getHttpServer()).post(`/v1/integrations/credentials/${created.body.id}/test`).set(auth).expect(201);
    expect(testResult.body.ok).toBe(true);
  });

  it('CRUDs connections with tenant isolation', async () => {
    const tenant = await createTestTenant(MANAGER);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    const created = await request(app.getHttpServer())
      .post('/v1/integrations/connections')
      .set(auth)
      .send({ name: 'CSV customer import', connectorType: 'CSV', direction: 'IMPORT', targetEntity: 'customers', config: {} })
      .expect(201);
    const connectionId = created.body.id as string;

    const list = await request(app.getHttpServer()).get('/v1/integrations/connections').set(auth).expect(200);
    expect(list.body.items.map((c: { id: string }) => c.id)).toContain(connectionId);

    const got = await request(app.getHttpServer()).get(`/v1/integrations/connections/${connectionId}`).set(auth).expect(200);
    expect(got.body.name).toBe('CSV customer import');
    expect(got.body.fieldMappings).toEqual([]);

    await request(app.getHttpServer()).patch(`/v1/integrations/connections/${connectionId}`).set(auth).send({ name: 'Renamed' }).expect(200);

    // A second, unrelated tenant must not be able to see or archive it.
    const other = await createTestTenant(MANAGER);
    const otherToken = await login(other.username);
    await request(app.getHttpServer())
      .get(`/v1/integrations/connections/${connectionId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/v1/integrations/connections/${connectionId}/archive`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);

    await request(app.getHttpServer()).post(`/v1/integrations/connections/${connectionId}/archive`).set(auth).expect(201);
    const afterArchive = await request(app.getHttpServer()).get('/v1/integrations/connections').set(auth).expect(200);
    expect(afterArchive.body.items.map((c: { id: string }) => c.id)).not.toContain(connectionId);
  });

  it('CRUDs field mappings under a connection', async () => {
    const tenant = await createTestTenant(MANAGER);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    const connection = await request(app.getHttpServer())
      .post('/v1/integrations/connections')
      .set(auth)
      .send({ name: 'Mapping test', connectorType: 'CSV', direction: 'IMPORT', targetEntity: 'customers', config: {} })
      .expect(201);
    const connectionId = connection.body.id as string;

    const mapping = await request(app.getHttpServer())
      .post(`/v1/integrations/connections/${connectionId}/field-mappings`)
      .set(auth)
      .send({ externalField: 'CustomerName', fleetField: 'name', transform: 'TRIM', isRequired: true, order: 0 })
      .expect(201);
    const mappingId = mapping.body.id as string;

    const list = await request(app.getHttpServer()).get(`/v1/integrations/connections/${connectionId}/field-mappings`).set(auth).expect(200);
    expect(list.body.items).toHaveLength(1);

    await request(app.getHttpServer()).patch(`/v1/integrations/field-mappings/${mappingId}`).set(auth).send({ isRequired: false }).expect(200);

    await request(app.getHttpServer()).post(`/v1/integrations/field-mappings/${mappingId}/archive`).set(auth).expect(201);
    const afterArchive = await request(app.getHttpServer()).get(`/v1/integrations/connections/${connectionId}/field-mappings`).set(auth).expect(200);
    expect(afterArchive.body.items).toHaveLength(0);
  });

  it('runs a CSV manual sync: creates a real Customer via the reused imports path, and dead-letters a row missing a required field', async () => {
    const tenant = await createTestTenant(MANAGER);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    const connection = await request(app.getHttpServer())
      .post('/v1/integrations/connections')
      .set(auth)
      .send({ name: 'CSV customers', connectorType: 'CSV', direction: 'IMPORT', targetEntity: 'customers', config: {} })
      .expect(201);
    const connectionId = connection.body.id as string;

    await request(app.getHttpServer())
      .post(`/v1/integrations/connections/${connectionId}/field-mappings`)
      .set(auth)
      .send({ externalField: 'CustomerName', fleetField: 'name', transform: 'TRIM', isRequired: true, order: 0 })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/integrations/connections/${connectionId}/field-mappings`)
      .set(auth)
      .send({ externalField: 'ContactPhone', fleetField: 'phone', transform: 'NONE', isRequired: false, order: 1 })
      .expect(201);

    const uniqueName = `Acme Co ${Date.now()}`;
    const syncResult = await request(app.getHttpServer())
      .post(`/v1/integrations/connections/${connectionId}/sync`)
      .set(auth)
      .send({
        rows: [
          { CustomerName: ` ${uniqueName} `, ContactPhone: '0400 000 000' },
          { CustomerName: '   ', ContactPhone: '0400 111 111' }, // trims to empty -> missing required "name"
        ],
      })
      .expect(201);

    expect(syncResult.body.recordsProcessed).toBe(2);
    expect(syncResult.body.recordsSucceeded).toBe(1);
    expect(syncResult.body.recordsFailed).toBe(1);
    expect(syncResult.body.status).toBe('PARTIAL_FAILURE');

    // The valid row really created a Customer via CustomersService.create — not a simulated write.
    const customers = await request(app.getHttpServer()).get(`/v1/customers?search=${encodeURIComponent(uniqueName)}`).set(auth).expect(200);
    expect(customers.body.items.some((c: { name: string }) => c.name === uniqueName)).toBe(true);

    // The bad row never aborted the batch — it landed in the dead letter queue instead.
    const deadLetters = await request(app.getHttpServer()).get(`/v1/integrations/connections/${connectionId}/dead-letters`).set(auth).expect(200);
    expect(deadLetters.body.items).toHaveLength(1);
    expect(deadLetters.body.items[0].errorMessage).toMatch(/name/);
    expect(deadLetters.body.items[0].rawPayload.ContactPhone).toBe('0400 111 111');
    expect(deadLetters.body.items[0].status).toBe('PENDING_RETRY');

    const syncRuns = await request(app.getHttpServer()).get(`/v1/integrations/connections/${connectionId}/sync-runs`).set(auth).expect(200);
    expect(syncRuns.body.items[0].status).toBe('PARTIAL_FAILURE');

    const dashboard = await request(app.getHttpServer()).get('/v1/integrations/dashboard').set(auth).expect(200);
    expect(dashboard.body.pendingDeadLetters).toBeGreaterThanOrEqual(1);
  });

  it('receives an incoming webhook: valid signature succeeds, wrong signature 401s, unknown token 404s', async () => {
    const tenant = await createTestTenant(MANAGER);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };
    const secret = 'whsec_test_only_do_not_reuse';

    const credential = await request(app.getHttpServer())
      .post('/v1/integrations/credentials')
      .set(auth)
      .send({ name: 'Webhook signing secret', authType: 'WEBHOOK_SECRET', secretValue: secret })
      .expect(201);

    const webhook = await request(app.getHttpServer())
      .post('/v1/integrations/webhooks')
      .set(auth)
      .send({ name: 'Inbound test webhook', direction: 'INCOMING', secretCredentialId: credential.body.id })
      .expect(201);
    const inboundToken = webhook.body.inboundToken as string;
    expect(inboundToken).toBeTruthy();

    const rawBody = JSON.stringify({ hello: 'world' });
    const validSignature = createHmac('sha256', secret).update(rawBody).digest('hex');

    await request(app.getHttpServer())
      .post(`/v1/integrations/webhooks/in/${inboundToken}`)
      .set('Content-Type', 'application/json')
      .set('x-fleethq-signature', validSignature)
      .send(rawBody)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/v1/integrations/webhooks/in/${inboundToken}`)
      .set('Content-Type', 'application/json')
      .set('x-fleethq-signature', 'not-the-right-signature')
      .send(rawBody)
      .expect(401);

    await request(app.getHttpServer())
      .post('/v1/integrations/webhooks/in/this-token-does-not-exist')
      .set('Content-Type', 'application/json')
      .send('{}')
      .expect(404);

    const deliveries = await request(app.getHttpServer()).get(`/v1/integrations/webhooks/${webhook.body.id}/deliveries`).set(auth).expect(200);
    expect(deliveries.body.items.length).toBeGreaterThanOrEqual(2); // one success, one failed-signature
    expect(deliveries.body.items.some((d: { success: boolean }) => d.success)).toBe(true);
    expect(deliveries.body.items.some((d: { success: boolean }) => !d.success)).toBe(true);
  });

  it('requires integrations:view to list connections and integrations:manage to create one', async () => {
    const noPerms = await createTestTenant([]);
    const noPermsToken = await login(noPerms.username);

    const viewList = await request(app.getHttpServer())
      .get('/v1/integrations/connections')
      .set('Authorization', `Bearer ${noPermsToken}`)
      .expect(403);
    expect(viewList.body.error.requiredPermission).toBe(PERMISSIONS.INTEGRATIONS_VIEW);

    const viewer = await createTestTenant([PERMISSIONS.INTEGRATIONS_VIEW]);
    const viewerToken = await login(viewer.username);
    const createAttempt = await request(app.getHttpServer())
      .post('/v1/integrations/connections')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ name: 'Should be denied', connectorType: 'CSV', direction: 'IMPORT', targetEntity: 'customers', config: {} })
      .expect(403);
    expect(createAttempt.body.error.requiredPermission).toBe(PERMISSIONS.INTEGRATIONS_MANAGE);
  });
});
