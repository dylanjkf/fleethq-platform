import { RetentionService } from './retention.service';

/**
 * Unit coverage for the Stripe webhook idempotency-ledger retention pass added
 * for the audit remediation (billing). The GPS purge already has e2e coverage;
 * this asserts the new pass deletes past the bounded window via the privileged
 * SystemPrismaService (the same role that writes the ledger), without a DB.
 */
describe('RetentionService.purgeStripeWebhookEvents', () => {
  function build(retentionDays?: string) {
    const systemPrisma = { stripeWebhookEvent: { deleteMany: jest.fn().mockResolvedValue({ count: 7 }) } };
    const config = { get: (key: string) => (key === 'STRIPE_WEBHOOK_EVENT_RETENTION_DAYS' ? retentionDays : undefined) };
    const service = new RetentionService({} as never, systemPrisma as never, config as never);
    return { service, systemPrisma };
  }

  it('deletes ledger rows older than the default 90-day window', async () => {
    const { service, systemPrisma } = build();
    const now = new Date('2026-08-02T00:00:00.000Z');
    const count = await service.purgeStripeWebhookEvents(now);

    expect(count).toBe(7);
    const arg = systemPrisma.stripeWebhookEvent.deleteMany.mock.calls[0][0];
    const cutoff = arg.where.receivedAt.lt as Date;
    const expected = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    expect(cutoff.getTime()).toBe(expected.getTime());
  });

  it('honours a configured STRIPE_WEBHOOK_EVENT_RETENTION_DAYS override', async () => {
    const { service, systemPrisma } = build('30');
    const now = new Date('2026-08-02T00:00:00.000Z');
    await service.purgeStripeWebhookEvents(now);

    const cutoff = systemPrisma.stripeWebhookEvent.deleteMany.mock.calls[0][0].where.receivedAt.lt as Date;
    expect(cutoff.getTime()).toBe(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).getTime());
  });
});
