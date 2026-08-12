/**
 * Self-serve signup — checkout-session creation (audit H3 + H9).
 *
 * The existing signup-billing suite drives provisioning by staging a
 * pending_signup directly, so the checkout-session *creation* path (the public
 * POST /v1/signup that talks to Stripe and writes the hashed password) had no
 * direct coverage. This exercises it with a stubbed Stripe client and asserts:
 *  - H9: a checkout session is created with the configured per-asset price and
 *        requested quantity, and a PENDING pending_signup row is written; and
 *  - H3: the stored password hash encodes the centralized bcrypt cost (12),
 *        not the previously-hardcoded 10.
 */
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { BillingService } from '../src/billing/billing.service';
import { buildTestApp } from './utils/build-test-app';
import { disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const ownerPrisma = new PrismaClient();
const PER_ASSET_PRICE = 'price_signup_checkout_test';

describe('Signup checkout-session creation', () => {
  let app: INestApplication;
  let billing: BillingService;
  let createSession: jest.Mock;

  beforeAll(async () => {
    process.env.STRIPE_PRICE_PER_ASSET = PER_ASSET_PRICE;
    process.env.APP_BASE_URL = 'https://app.fleethq.test';
    app = await buildTestApp();
    billing = app.get(BillingService);
    await ensureAssetClasses();
    await ensurePermissions();
  });

  afterAll(async () => {
    delete process.env.STRIPE_PRICE_PER_ASSET;
    delete process.env.APP_BASE_URL;
    await app.close();
    await disconnectFixtures();
    await ownerPrisma.$disconnect();
  });

  beforeEach(() => {
    createSession = jest.fn().mockResolvedValue({ id: `cs_${randomUUID()}`, url: 'https://checkout.stripe.test/session' });
    // Stripe is never really reached: stub the client + configuration flags so
    // the checkout-start path runs end-to-end without network.
    jest.spyOn(billing, 'isConfigured').mockReturnValue(true);
    jest.spyOn(billing, 'isTaxEnabled').mockReturnValue(false);
    jest.spyOn(billing, 'getStripeClient').mockReturnValue({ checkout: { sessions: { create: createSession } } } as never);
  });

  afterEach(() => jest.restoreAllMocks());

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      companyName: 'Acme Freight',
      adminName: 'Dana Owner',
      adminEmail: `owner-${randomUUID()}@acmefreight.test`,
      adminPassword: 'Str0ng-Passw0rd!',
      quantity: 7,
      acceptedTerms: true,
      ...overrides,
    };
  }

  it('H9: creates a Stripe checkout session with the configured price + quantity and stages a PENDING signup', async () => {
    const body = payload();
    const res = await request(app.getHttpServer()).post('/v1/signup').send(body).expect(201);
    expect(res.body.checkoutUrl ?? res.body.url).toBe('https://checkout.stripe.test/session');

    expect(createSession).toHaveBeenCalledTimes(1);
    const [params] = createSession.mock.calls[0];
    expect(params.mode).toBe('subscription');
    expect(params.line_items[0].price).toBe(PER_ASSET_PRICE);
    expect(params.line_items[0].quantity).toBe(7);
    expect(params.success_url).toContain('/signup/complete');

    const staged = await ownerPrisma.pendingSignup.findFirst({ where: { adminEmail: body.adminEmail } });
    expect(staged?.status).toBe('PENDING');
    expect(staged?.requestedQuantity).toBe(7);
  });

  it('H3: stores the admin password hashed at the centralized bcrypt cost (12), not 10', async () => {
    const body = payload();
    await request(app.getHttpServer()).post('/v1/signup').send(body).expect(201);

    const staged = await ownerPrisma.pendingSignup.findFirst({ where: { adminEmail: body.adminEmail } });
    const hash = staged?.hashedPassword;
    expect(typeof hash).toBe('string');
    // The cost factor is embedded in the hash ($2b$<cost>$…). resolveBcryptCost()
    // defaults to 12; the pre-fix code hardcoded 10.
    expect(bcrypt.getRounds(hash as string)).toBe(12);
    // And the hash actually verifies the password (not a mangled value).
    expect(await bcrypt.compare(body.adminPassword, hash as string)).toBe(true);
  });
});
