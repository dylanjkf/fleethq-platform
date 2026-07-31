import { ConfigService } from '@nestjs/config';
import { AuthMailService } from './auth-mail.service';
import type { EmailMessage, NotificationChannel, SmsMessage } from '../notifications/channels/notification-channel';

/**
 * Unit tests for the four security-notification emails added in Auth/Billing
 * Platform Phase 6 (sendPasswordChanged/sendMfaEnabled/sendMfaDisabled/
 * sendAccountLocked) — the pre-existing methods are already exercised
 * end-to-end via the auth e2e specs. A stub NotificationChannel captures what
 * would be sent rather than talking to any real provider.
 */
describe('AuthMailService — Phase 6 security notification emails', () => {
  const sendEmail = jest.fn<Promise<void>, [EmailMessage]>().mockResolvedValue(undefined);
  const channel: NotificationChannel = {
    sendEmail,
    sendSms: jest.fn<Promise<void>, [SmsMessage]>().mockResolvedValue(undefined),
  };
  const config = { get: (_key: string, fallback?: string) => fallback } as unknown as ConfigService;
  const mail = new AuthMailService(channel, config);

  beforeEach(() => sendEmail.mockClear());

  it('sendPasswordChanged addresses the account holder and does not leak the new password', async () => {
    await mail.sendPasswordChanged('ada@example.com', 'Ada Lovelace');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const message = sendEmail.mock.calls[0][0];
    expect(message.to).toBe('ada@example.com');
    expect(message.subject).toMatch(/password was changed/i);
    expect(message.body).toContain('Ada Lovelace');
    expect(message.body.toLowerCase()).not.toContain('password:');
  });

  it('sendMfaEnabled confirms two-factor was turned on', async () => {
    await mail.sendMfaEnabled('ada@example.com', 'Ada Lovelace');
    const message = sendEmail.mock.calls[0][0];
    expect(message.subject).toMatch(/enabled/i);
    expect(message.body).toContain('Ada Lovelace');
  });

  it('sendMfaDisabled warns this is a takeover-risk signal', async () => {
    await mail.sendMfaDisabled('ada@example.com', 'Ada Lovelace');
    const message = sendEmail.mock.calls[0][0];
    expect(message.subject).toMatch(/disabled/i);
    expect(message.body).toMatch(/compromised/i);
  });

  it('sendAccountLocked reports the actual unlock time', async () => {
    const unlockAt = new Date('2026-08-01T03:00:00.000Z');
    await mail.sendAccountLocked('ada@example.com', 'Ada Lovelace', unlockAt);
    const message = sendEmail.mock.calls[0][0];
    expect(message.subject).toMatch(/locked/i);
    expect(message.body).toContain(unlockAt.toLocaleDateString('en-AU'));
  });
});
