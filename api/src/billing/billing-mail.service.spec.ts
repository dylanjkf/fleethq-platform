import { ConfigService } from '@nestjs/config';
import { BillingMailService } from './billing-mail.service';
import type { EmailMessage, NotificationChannel, SmsMessage } from '../notifications/channels/notification-channel';

/**
 * Unit tests for the billing email notifications added in Auth/Billing
 * Platform Phase 6 — the wiring into BillingService's webhook handlers is
 * covered by test/billing.e2e-spec.ts (Phase 5); this verifies the email
 * content itself against a stub NotificationChannel.
 */
describe('BillingMailService', () => {
  const sendEmail = jest.fn<Promise<void>, [EmailMessage]>().mockResolvedValue(undefined);
  const channel: NotificationChannel = {
    sendEmail,
    sendSms: jest.fn<Promise<void>, [SmsMessage]>().mockResolvedValue(undefined),
  };
  const config = { get: (_key: string, fallback?: string) => fallback } as unknown as ConfigService;
  const mail = new BillingMailService(channel, config);

  beforeEach(() => sendEmail.mockClear());

  it('sendPaymentFailed names the company, the next retry date, and the grace deadline when Stripe will retry', async () => {
    const nextAttempt = new Date('2026-08-03T00:00:00.000Z');
    const graceEndsAt = new Date('2026-08-10T00:00:00.000Z');
    await mail.sendPaymentFailed('billing@acme.example', 'Ada Owner', 'Acme Couriers', nextAttempt, graceEndsAt);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const message = sendEmail.mock.calls[0][0];
    expect(message.to).toBe('billing@acme.example');
    expect(message.subject).toContain('Acme Couriers');
    expect(message.body).toContain('Ada Owner');
    expect(message.body).toContain(nextAttempt.toLocaleDateString('en-AU'));
    // The 5 business-day grace deadline is surfaced so the customer knows how long they have.
    expect(message.body).toContain(graceEndsAt.toLocaleDateString('en-AU'));
    expect(message.body).toMatch(/grace period/i);
  });

  it('sendPaymentFailed says retries are exhausted when there is no next attempt', async () => {
    await mail.sendPaymentFailed('billing@acme.example', 'Ada Owner', 'Acme Couriers', null, new Date('2026-08-10T00:00:00.000Z'));
    const message = sendEmail.mock.calls[0][0];
    expect(message.body).toMatch(/unable to schedule an automatic retry/i);
  });

  it('sendPaymentRecovered confirms the subscription is back in good standing', async () => {
    await mail.sendPaymentRecovered('billing@acme.example', 'Ada Owner', 'Acme Couriers');
    const message = sendEmail.mock.calls[0][0];
    expect(message.subject).toContain('Acme Couriers');
    expect(message.body).toMatch(/no longer past due/i);
  });
});
