/**
 * Attached-unit detail view: the structured specs a unit can now carry, and the
 * hitch history derived from the timed PAIRED_WITH fleet-graph relationships
 * (rather than a duplicate log). Also pins that spec edits land on the unit's
 * timeline, since a changed VIN/registration is audit-relevant.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const PERMS = [
  PERMISSIONS.ATTACHED_UNITS_VIEW,
  PERMISSIONS.ATTACHED_UNITS_CREATE,
  PERMISSIONS.ATTACHED_UNITS_EDIT,
  PERMISSIONS.ASSETS_VIEW,
  PERMISSIONS.ASSETS_CREATE,
];

describe('Attached unit detail', () => {
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

  it('stores structured specs and returns them on the detail endpoint', async () => {
    const t = await createTestTenant(PERMS);
    const auth = { Authorization: `Bearer ${await login(t.username)}` };

    const created = await request(app.getHttpServer())
      .post('/v1/attached-units')
      .set(auth)
      .send({
        name: 'Tri-axle curtainsider',
        externalReference: 'TRL-004',
        make: 'Krueger',
        model: 'ST3-44',
        year: 2019,
        vin: '1FUJGLDR4CLBP8834',
        registration: 'XT44QP',
        notes: 'Curtain replaced 2026-03.',
        customFields: { palletCapacity: 34 },
      })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/v1/attached-units/${created.body.id}/detail`)
      .set(auth)
      .expect(200);

    expect(detail.body).toMatchObject({
      name: 'Tri-axle curtainsider',
      make: 'Krueger',
      model: 'ST3-44',
      year: 2019,
      registration: 'XT44QP',
      customFields: { palletCapacity: 34 },
    });
    // Nothing hitched yet.
    expect(detail.body.currentAsset).toBeNull();
    expect(detail.body.hitchHistory).toEqual([]);
  });

  it('builds hitch history from the fleet graph, marking the open pairing current', async () => {
    const t = await createTestTenant(PERMS);
    const auth = { Authorization: `Bearer ${await login(t.username)}` };

    const unit = await request(app.getHttpServer())
      .post('/v1/attached-units').set(auth).send({ name: 'Dolly 1' }).expect(201);
    const truckA = await request(app.getHttpServer())
      .post('/v1/assets').set(auth).send({ name: 'Truck A' }).expect(201);
    const truckB = await request(app.getHttpServer())
      .post('/v1/assets').set(auth).send({ name: 'Truck B' }).expect(201);

    // Hitch to A, unhitch, then hitch to B and leave it on.
    await request(app.getHttpServer()).post(`/v1/attached-units/${unit.body.id}/hitch`).set(auth).send({ assetId: truckA.body.id }).expect(201);
    await request(app.getHttpServer()).post(`/v1/attached-units/${unit.body.id}/unhitch`).set(auth).expect(201);
    await request(app.getHttpServer()).post(`/v1/attached-units/${unit.body.id}/hitch`).set(auth).send({ assetId: truckB.body.id }).expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/v1/attached-units/${unit.body.id}/detail`).set(auth).expect(200);

    expect(detail.body.currentAsset).toMatchObject({ id: truckB.body.id, name: 'Truck B' });
    expect(detail.body.hitchHistory).toHaveLength(2);

    const current = detail.body.hitchHistory.find((h: { isCurrent: boolean }) => h.isCurrent);
    expect(current).toMatchObject({ assetName: 'Truck B', unhitchedAt: null });

    const closed = detail.body.hitchHistory.find((h: { isCurrent: boolean }) => !h.isCurrent);
    expect(closed).toMatchObject({ assetName: 'Truck A' });
    expect(closed.unhitchedAt).not.toBeNull();
  });

  it('records a spec change on the unit timeline', async () => {
    const t = await createTestTenant([...PERMS, PERMISSIONS.TIMELINE_VIEW]);
    const auth = { Authorization: `Bearer ${await login(t.username)}` };

    const unit = await request(app.getHttpServer())
      .post('/v1/attached-units').set(auth).send({ name: 'Skel 9', registration: 'AAA111' }).expect(201);

    await request(app.getHttpServer())
      .patch(`/v1/attached-units/${unit.body.id}`).set(auth).send({ registration: 'BBB222' }).expect(200);

    const timeline = await request(app.getHttpServer())
      .get('/v1/timeline')
      .query({ entityType: 'ATTACHED_UNIT', entityId: unit.body.id })
      .set(auth)
      .expect(200);

    const updated = timeline.body.items.find((e: { eventType: string }) => e.eventType === 'updated');
    expect(updated).toBeDefined();
    expect(updated.payload.registration).toMatchObject({ from: 'AAA111', to: 'BBB222' });
  });
});
