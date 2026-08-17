/**
 * Configurable, multi-drop-aware Proof of Delivery (docs/design/Configurable_POD.md).
 *
 * (1) A tenant configures a DELIVERY form template ("photo required, signature
 *     optional") and completeStop enforces it server-side: a confirmation
 *     without the photo is rejected, with it succeeds. This test MUST fail if
 *     the required-evidence enforcement is removed.
 * (2) Multi-drop: one stop with several parcels, ONE shared evidence capture,
 *     and every covered parcel is individually marked delivered/reportable.
 */
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

// 1x1 PNG and a tiny valid JPEG — magic numbers must match the declared type
// (AttachmentsService sniffs the bytes).
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNCwsLDBkSEw8UHRofGh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDsyNDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJQA/9k=';

const FULL = [
  PERMISSIONS.DISPATCH_VIEW,
  PERMISSIONS.DISPATCH_CREATE,
  PERMISSIONS.DISPATCH_EDIT,
  PERMISSIONS.DISPATCH_DELIVER,
  PERMISSIONS.FORMS_VIEW,
  PERMISSIONS.FORMS_CREATE,
  PERMISSIONS.FORMS_EDIT,
  PERMISSIONS.FORMS_ARCHIVE,
];

describe('Configurable POD', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await disconnectFixtures();
  });

  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function createDeliveryTemplate(token: string) {
    return request(app.getHttpServer())
      .post('/v1/form-templates')
      .set(auth(token))
      .send({
        name: 'Drop confirmation',
        targetContext: 'DELIVERY',
        fields: [
          { id: 'photo', label: 'Doorstep photo', type: 'photo', required: true },
          { id: 'sig', label: 'Signature', type: 'signature', required: false },
          { id: 'recipient', label: 'Received by', type: 'text', required: false },
        ],
      });
  }

  async function makeStopWithParcels(token: string, parcelRefs: string[]): Promise<{ jobId: string; stopId: string; parcelIds: string[] }> {
    const job = await request(app.getHttpServer()).post('/v1/jobs').set(auth(token)).send({ title: 'POD run' }).expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops`)
      .set(auth(token))
      .send({ stops: [{ label: 'Apartment block, one door' }] })
      .expect(201);
    const withStops = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set(auth(token)).expect(200);
    const stopId = withStops.body.stops[0].id as string;

    if (parcelRefs.length > 0) {
      await request(app.getHttpServer())
        .post(`/v1/jobs/${job.body.id}/stops/${stopId}/parcels`)
        .set(auth(token))
        .send({ parcels: parcelRefs.map((reference) => ({ reference })) })
        .expect(201);
    }
    const reread = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set(auth(token)).expect(200);
    const parcelIds = reread.body.stops[0].parcels.map((p: { id: string }) => p.id);
    return { jobId: job.body.id, stopId, parcelIds };
  }

  async function scanParcel(token: string, jobId: string, stopId: string, reference: string) {
    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/parcels/scan`)
      .set(auth(token))
      .send({ reference })
      .expect(201);
  }

  it('records a pod_unconfirmed_override (who/when/what) when a delivery covers an unscanned parcel', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    // No DELIVERY template → legacy POD path, so no evidence is needed to isolate
    // the unconfirmed-parcel recording.
    const { jobId, stopId } = await makeStopWithParcels(token, ['P-A', 'P-B']);

    // Scan only P-A; P-B is delivered WITHOUT ever being scanned/confirmed.
    await scanParcel(token, jobId, stopId, 'P-A');

    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/complete`)
      .set(auth(token))
      .send({ outcome: 'DELIVERED' })
      .expect(201);

    // The override was recorded — never silent — naming WHO, WHEN, and exactly
    // WHAT went out unconfirmed (P-B only; P-A was scanned).
    const events = await prisma.timelineEvent.findMany({ where: { entityId: jobId, eventType: 'pod_unconfirmed_override' } });
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.actorUserId).toBe(tenant.userId); // WHO
    expect(event.occurredAt).toBeTruthy(); // WHEN
    const payload = event.payload as { unconfirmedReferences: string[]; unconfirmedCount: number };
    expect(payload.unconfirmedReferences).toEqual(['P-B']); // WHAT (P-A excluded — it was scanned)
    expect(payload.unconfirmedCount).toBe(1);
  });

  it('records NO override when every covered parcel was scanned first', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId, stopId } = await makeStopWithParcels(token, ['Q-A', 'Q-B']);

    await scanParcel(token, jobId, stopId, 'Q-A');
    await scanParcel(token, jobId, stopId, 'Q-B');

    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/complete`)
      .set(auth(token))
      .send({ outcome: 'DELIVERED' })
      .expect(201);

    const events = await prisma.timelineEvent.findMany({ where: { entityId: jobId, eventType: 'pod_unconfirmed_override' } });
    expect(events).toHaveLength(0);
  });

  it('enforces "photo required, signature optional" server-side: rejects a drop without the photo, accepts it with', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    await createDeliveryTemplate(token).expect(201);

    const { jobId, stopId } = await makeStopWithParcels(token, ['P-A']);

    // No evidence object at all → POD_EVIDENCE_REQUIRED.
    const noEvidence = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/complete`)
      .set(auth(token))
      .send({ outcome: 'DELIVERED' })
      .expect(400);
    expect(noEvidence.body.error.code).toBe('POD_EVIDENCE_REQUIRED');

    // Evidence present but the required photo omitted → FORM_FIELD_REQUIRED.
    // (This is the assertion that must fail if enforcement is removed.)
    const missingPhoto = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/complete`)
      .set(auth(token))
      .send({ outcome: 'DELIVERED', evidence: { answers: [{ fieldId: 'recipient', value: 'J. Smith' }] } })
      .expect(400);
    expect(missingPhoto.body.error.code).toBe('FORM_FIELD_REQUIRED');

    // Stop is still PENDING — the rejected attempts didn't complete it.
    const stillPending = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set(auth(token)).expect(200);
    expect(stillPending.body.stops[0].outcome).toBe('PENDING');

    // With the required photo (signature omitted, since optional) → succeeds.
    const ok = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/complete`)
      .set(auth(token))
      .send({
        outcome: 'DELIVERED',
        evidence: {
          answers: [
            { fieldId: 'photo', value: { contentType: 'image/jpeg', filename: 'door.jpg', base64: JPEG_B64 } },
            { fieldId: 'recipient', value: 'J. Smith' },
          ],
        },
      })
      .expect(201);
    expect(ok.body.stop.outcome).toBe('DELIVERED');
    expect(ok.body.stop.podSubmissionId).toBeTruthy();

    // The evidence is a real, snapshotting FormSubmission — the photo answer is
    // stored as an Attachment id, never raw base64.
    const submission = await request(app.getHttpServer())
      .get(`/v1/form-submissions/${ok.body.stop.podSubmissionId}`)
      .set(auth(token))
      .expect(200);
    const photoAnswer = submission.body.answers.find((a: { fieldId: string }) => a.fieldId === 'photo');
    expect(typeof photoAnswer.value).toBe('string');
    expect(photoAnswer.value).not.toContain('/9j/');
  });

  it('multi-drop: one shared evidence capture marks every covered parcel delivered, each individually tracked', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    await createDeliveryTemplate(token).expect(201);

    // Three parcels handed over at one door.
    const { jobId, stopId, parcelIds } = await makeStopWithParcels(token, ['MD-1', 'MD-2', 'MD-3']);
    expect(parcelIds).toHaveLength(3);

    const res = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/complete`)
      .set(auth(token))
      .send({
        outcome: 'DELIVERED',
        // parcelIds omitted → all parcels at the stop are covered.
        evidence: {
          id: randomUUID(),
          answers: [
            { fieldId: 'photo', value: { contentType: 'image/png', filename: 'door.png', base64: PNG_B64 } },
            { fieldId: 'sig', value: { contentType: 'image/png', filename: 'sig.png', base64: PNG_B64 } },
          ],
        },
      })
      .expect(201);
    expect(res.body.stop.outcome).toBe('DELIVERED');
    const submissionId = res.body.stop.podSubmissionId as string;
    expect(submissionId).toBeTruthy();

    // Every parcel is delivered, each with its own deliveredAt, all sharing the
    // ONE submission — per-parcel status is individually recorded and reportable.
    const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set(auth(token)).expect(200);
    const parcels = job.body.stops[0].parcels as Array<{ id: string; deliveredAt: string | null; podSubmissionId: string | null }>;
    expect(parcels).toHaveLength(3);
    for (const parcel of parcels) {
      expect(parcel.deliveredAt).not.toBeNull();
      expect(parcel.podSubmissionId).toBe(submissionId);
    }
    // The shared capture really is a single submission.
    expect(new Set(parcels.map((p) => p.podSubmissionId)).size).toBe(1);
    // The job rolled up to COMPLETED (its only stop is done).
    expect(res.body.jobCompleted).toBe(true);
  });

  it('covers only the named parcels when parcelIds is supplied, and rejects a parcel not on the stop', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    await createDeliveryTemplate(token).expect(201);
    const { jobId, stopId, parcelIds } = await makeStopWithParcels(token, ['S-1', 'S-2']);

    // A parcel id that isn't on this stop → POD_PARCEL_NOT_ON_STOP.
    const bad = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/complete`)
      .set(auth(token))
      .send({
        outcome: 'DELIVERED',
        parcelIds: [randomUUID()],
        evidence: { answers: [{ fieldId: 'photo', value: { contentType: 'image/png', base64: PNG_B64 } }] },
      })
      .expect(400);
    expect(bad.body.error.code).toBe('POD_PARCEL_NOT_ON_STOP');

    // Cover just one of the two parcels.
    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/complete`)
      .set(auth(token))
      .send({
        outcome: 'DELIVERED',
        parcelIds: [parcelIds[0]],
        evidence: { answers: [{ fieldId: 'photo', value: { contentType: 'image/png', base64: PNG_B64 } }] },
      })
      .expect(201);

    const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set(auth(token)).expect(200);
    const byId = new Map(job.body.stops[0].parcels.map((p: { id: string; deliveredAt: string | null }) => [p.id, p.deliveredAt]));
    expect(byId.get(parcelIds[0])).not.toBeNull();
    expect(byId.get(parcelIds[1])).toBeNull();
  });

  it('without a DELIVERY template configured, the legacy POD path still completes a stop (backward compatible)', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    // No DELIVERY template created.
    const { jobId, stopId, parcelIds } = await makeStopWithParcels(token, ['L-1']);

    const res = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/complete`)
      .set(auth(token))
      .send({ outcome: 'DELIVERED', podPhotoBase64: JPEG_B64, recipientName: 'Legacy' })
      .expect(201);
    expect(res.body.stop.outcome).toBe('DELIVERED');
    expect(res.body.stop.podSubmissionId).toBeNull();

    // Parcels are still marked delivered even without configured evidence.
    const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set(auth(token)).expect(200);
    expect(job.body.stops[0].parcels[0].deliveredAt).not.toBeNull();
    expect(job.body.stops[0].parcels[0].podSubmissionId).toBeNull();
    expect(parcelIds).toHaveLength(1);
  });

  it('allows only one active DELIVERY template per company', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const first = await createDeliveryTemplate(token).expect(201);

    // A second active DELIVERY template is a conflict.
    const second = await createDeliveryTemplate(token).expect(409);
    expect(second.body.error.code).toBe('DELIVERY_TEMPLATE_EXISTS');

    // Archive the first, then a new one is allowed.
    await request(app.getHttpServer()).post(`/v1/form-templates/${first.body.id}/archive`).set(auth(token)).expect(201);
    await createDeliveryTemplate(token).expect(201);
  });
});
