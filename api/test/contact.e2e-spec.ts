/**
 * POST /v1/contact is the public "get in touch" enquiry form — FleetHQ has
 * no self-service signup/free-trial (see companies.e2e-spec.ts), so this is
 * the only unauthenticated write path a prospective customer ever reaches.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { buildTestApp } from './utils/build-test-app';
import { disconnectFixtures } from './utils/fixtures';

describe('Contact', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
  });

  it('accepts a valid enquiry', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/contact')
      .send({
        name: 'Jane Prospect',
        email: 'jane@example.com',
        message: 'Interested in FleetHQ for our courier fleet.',
      })
      .expect(201);

    expect(res.body).toEqual({ received: true });
  });

  it('rejects a missing message', async () => {
    await request(app.getHttpServer())
      .post('/v1/contact')
      .send({ name: 'Jane Prospect', email: 'jane@example.com', message: '' })
      .expect(400);
  });

  it('rejects an invalid email', async () => {
    await request(app.getHttpServer())
      .post('/v1/contact')
      .send({ name: 'Jane Prospect', email: 'not-an-email', message: 'Hello' })
      .expect(400);
  });

  it('requires no authentication', async () => {
    // Confirms @Public() is actually wired — a regression here would 401
    // every prospect trying to reach the business, not just fail a test.
    const res = await request(app.getHttpServer())
      .post('/v1/contact')
      .send({ name: 'Anon', email: 'anon@example.com', message: 'No token attached.' });

    expect(res.status).not.toBe(401);
  });
});
