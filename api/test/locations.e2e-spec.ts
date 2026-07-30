/**
 * Live operator location (05-Dispatch/Dispatch_Overview.md's "where is my
 * driver now"): a linked Operator login reports its position while on shift,
 * and the office reads the fleet's last-known positions from the dispatch
 * board. Only a linked Operator can report; a garbage fix is rejected; and one
 * tenant never sees another's positions.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createOperatorLinkedToUser, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const OPERATOR = [PERMISSIONS.LOCATION_REPORT];
const OFFICE = [PERMISSIONS.LOCATION_VIEW];

describe('Locations (live driver position)', () => {
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

  it('reports an operator position and surfaces it on the fleet view', async () => {
    const tenant = await createTestTenant([...OPERATOR, ...OFFICE]);
    const token = await login(tenant.username);
    const operatorId = await createOperatorLinkedToUser(tenant.companyId, tenant.userId, 'Dana Driver');

    const emptyBefore = await request(app.getHttpServer()).get('/v1/locations').set('Authorization', `Bearer ${token}`).expect(200);
    expect(emptyBefore.body.items).toHaveLength(0);

    await request(app.getHttpServer())
      .post('/v1/locations')
      .set('Authorization', `Bearer ${token}`)
      .send({ lat: -37.8136, lng: 144.9631, accuracyM: 12 })
      .expect(201);

    const fleet = await request(app.getHttpServer()).get('/v1/locations').set('Authorization', `Bearer ${token}`).expect(200);
    expect(fleet.body.items).toHaveLength(1);
    expect(fleet.body.items[0]).toMatchObject({ operatorId, fullName: 'Dana Driver', lat: -37.8136, lng: 144.9631 });
    expect(fleet.body.items[0].lastLocationAt).toBeTruthy();
    // Live-map enrichment: no active job/shift here, so the extras are empty
    // but present (the map relies on the shape).
    expect(fleet.body.items[0].onShift).toBe(false);
    expect(fleet.body.items[0].activeJob).toBeNull();
    expect(fleet.body.items[0].unit).toBeNull();
  });

  it('rejects a position from a caller with no linked Operator', async () => {
    const office = await createTestTenant(OPERATOR);
    const token = await login(office.username);
    const res = await request(app.getHttpServer())
      .post('/v1/locations')
      .set('Authorization', `Bearer ${token}`)
      .send({ lat: -37.8, lng: 144.9 })
      .expect(409);
    expect(res.body.error.code).toBe('LOCATION_OPERATOR_REQUIRED');
  });

  it('rejects an out-of-range coordinate', async () => {
    const tenant = await createTestTenant(OPERATOR);
    const token = await login(tenant.username);
    await createOperatorLinkedToUser(tenant.companyId, tenant.userId, 'Dana Driver');
    await request(app.getHttpServer())
      .post('/v1/locations')
      .set('Authorization', `Bearer ${token}`)
      .send({ lat: 999, lng: 144.9 })
      .expect(400);
  });

  it('enforces the LOCATION_VIEW permission on the fleet view', async () => {
    const tenant = await createTestTenant(OPERATOR); // report-only, no view
    const token = await login(tenant.username);
    await request(app.getHttpServer()).get('/v1/locations').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('never leaks one tenant’s positions to another', async () => {
    const a = await createTestTenant([...OPERATOR, ...OFFICE]);
    const aToken = await login(a.username);
    await createOperatorLinkedToUser(a.companyId, a.userId, 'A Driver');
    await request(app.getHttpServer()).post('/v1/locations').set('Authorization', `Bearer ${aToken}`).send({ lat: -37.8, lng: 144.9 }).expect(201);

    const b = await createTestTenant([...OPERATOR, ...OFFICE]);
    const bToken = await login(b.username);
    const bFleet = await request(app.getHttpServer()).get('/v1/locations').set('Authorization', `Bearer ${bToken}`).expect(200);
    expect(bFleet.body.items).toHaveLength(0);
  });
});
