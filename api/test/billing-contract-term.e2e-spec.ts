/**
 * The 12-month minimum-term lock-in (Part 2), verified end-to-end AFTER the
 * flat-rate billing rewrite — since a lot of billing.service.ts changed, this
 * pins that the lock-in still works and is orthogonal to per-asset vs flat
 * pricing (it keys only on `contractEndsAt`/`contractReleasedAt`, never a price
 * or quantity).
 *
 * `isWithinMinimumTerm`'s boundary logic is unit-tested in minimum-term.spec;
 * this exercises the actual gate and the escape hatch:
 *  - with BILLING_CONTRACT_ENFORCED=true, a company inside its term is blocked
 *    from online self-cancellation with CONTRACT_LOCKED (before Stripe is
 *    touched, so no network/keys needed); and
 *  - the staff-only `cancel_for_cause` override (`releaseFromContract`) releases
 *    the company early and writes an audited MANUAL_OVERRIDE.
 */
import { randomUUID } from 'crypto';
import { BadRequestException, INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { BillingService } from '../src/billing/billing.service';
import { isWithinMinimumTerm } from '../src/billing/billing.service';
import { buildTestApp } from './utils/build-test-app';
import { createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const ownerPrisma = new PrismaClient();
const IN_200_DAYS = () => new Date(Date.now() + 200 * 24 * 60 * 60 * 1000);

describe('Billing 12-month minimum term (BILLING_CONTRACT_ENFORCED)', () => {
  let app: INestApplication;
  let billing: BillingService;

  beforeAll(async () => {
    // The lock-in is inert unless enforcement is on (held off by default pending
    // legal sign-off). Turn it on for this suite only, and tear it down after so
    // it can't leak into other suites.
    process.env.BILLING_CONTRACT_ENFORCED = 'true';
    app = await buildTestApp();
    billing = app.get(BillingService);
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    delete process.env.BILLING_CONTRACT_ENFORCED;
    await app.close();
    await disconnectFixtures();
    await ownerPrisma.$disconnect();
  });

  /** A company with a live subscription whose 12-month term is still running. */
  async function subscribedWithinTerm(): Promise<string> {
    const tenant = await createTestTenant([]);
    await ownerPrisma.company.update({
      where: { id: tenant.companyId },
      data: {
        subscriptionStatus: 'ACTIVE',
        // stripe_subscription_id is unique; keep it fresh per company so reruns
        // (persistent test tenants aren't torn down) don't collide.
        stripeSubscriptionId: `sub_${randomUUID()}`,
        subscriptionStartedAt: new Date(),
        contractEndsAt: IN_200_DAYS(),
        contractReleasedAt: null,
      },
    });
    return tenant.companyId;
  }

  it('blocks online cancellation while inside the term with CONTRACT_LOCKED, before touching Stripe', async () => {
    const companyId = await subscribedWithinTerm();

    let thrown: unknown;
    try {
      await billing.cancelSubscription(companyId);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getResponse()).toMatchObject({ code: 'CONTRACT_LOCKED' });

    // The rejection happens before any Stripe call or audit write.
    const audit = await ownerPrisma.billingAuditLog.findFirst({
      where: { companyId, eventType: 'SUBSCRIPTION_CANCELED' },
    });
    expect(audit).toBeNull();
  });

  it('cancel_for_cause releases the company early and writes an audited MANUAL_OVERRIDE', async () => {
    const companyId = await subscribedWithinTerm();
    const actorId = randomUUID();

    await billing.releaseFromContract(companyId, 'company shutting down', actorId);

    const company = await ownerPrisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: { contractReleasedAt: true, contractReleaseReason: true, contractEndsAt: true },
    });
    expect(company.contractReleasedAt).not.toBeNull();
    expect(company.contractReleaseReason).toBe('company shutting down');

    const audit = await ownerPrisma.billingAuditLog.findFirst({
      where: { companyId, eventType: 'MANUAL_OVERRIDE' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.detail).toMatchObject({ action: 'cancel_for_cause', reason: 'company shutting down' });
    expect(audit!.actorUserId).toBe(actorId);

    // The release lifts the lock even though the calendar term is still running.
    expect(isWithinMinimumTerm({ contractEndsAt: company.contractEndsAt, contractReleasedAt: company.contractReleasedAt })).toBe(false);
  });
});
