import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendEmailCommand, SendRawEmailCommand, SESClient } from '@aws-sdk/client-ses';
import type { EmailMessage, NotificationChannel, SmsMessage } from './notification-channel';

/** Wrap a base64 string at 76 characters per line (RFC 2045). */
function wrap76(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n');
}

/** RFC 2047 encoded-word for a header value that may contain non-ASCII (e.g. an en dash in a subject). */
function encodeHeaderWord(value: string): string {
  return /[^\x20-\x7e]/.test(value) ? `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=` : value;
}

/**
 * Real email delivery via AWS SES. Selected over LoggingNotificationChannel
 * only when `EMAIL_PROVIDER=ses` and `EMAIL_FROM_ADDRESS` are set (see
 * NotificationsModule) — so local dev and this codebase's own e2e/CI runs,
 * which have no SES account, keep using the logging channel with zero config.
 *
 * SES region + credentials come from the standard AWS SDK sources: in
 * production that's the ECS task role (no keys in the app), locally it's the
 * usual AWS env vars / profile. `AWS_REGION` is respected; the deployment's
 * own region (ap-southeast-2) is where SES is expected to live.
 *
 * SMS is deliberately still a no-op here: no SMS need has surfaced (every
 * notification lands in-app and, for opted-in users, by email), and wiring
 * SNS/Twilio would be a separate account + spend decision. It logs rather
 * than silently swallowing, so a future SMS caller is visible.
 */
@Injectable()
export class SesNotificationChannel implements NotificationChannel {
  private readonly logger = new Logger('NotificationChannel');
  private readonly client: SESClient;
  private readonly fromAddress: string;

  constructor(config: ConfigService) {
    this.client = new SESClient({ region: config.get<string>('AWS_REGION') });
    // Guaranteed present: NotificationsModule only wires this channel when
    // EMAIL_FROM_ADDRESS is set. The `?? ''` keeps the type non-optional
    // without a non-null assertion; the module's own guard is the real check.
    this.fromAddress = config.get<string>('EMAIL_FROM_ADDRESS') ?? '';
  }

  async sendEmail(message: EmailMessage): Promise<void> {
    // With attachments, SES needs a raw MIME message (SendEmail can't carry
    // files). Without, the simpler typed SendEmail is kept exactly as before.
    if (message.attachments && message.attachments.length > 0) {
      await this.client.send(new SendRawEmailCommand({ RawMessage: { Data: this.buildRawMime(message) } }));
      return;
    }
    await this.client.send(
      new SendEmailCommand({
        Source: this.fromAddress,
        Destination: { ToAddresses: [message.to] },
        Message: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: { Text: { Data: message.body, Charset: 'UTF-8' } },
        },
      }),
    );
  }

  /** Build a multipart/mixed MIME message (UTF-8 text body + base64 attachments). */
  private buildRawMime(message: EmailMessage): Uint8Array {
    const boundary = `=_fleethq_${Buffer.from(`${this.fromAddress}:${message.to}:${message.subject}`).toString('hex').slice(0, 24)}`;
    const parts: string[] = [
      `From: ${this.fromAddress}`,
      `To: ${message.to}`,
      `Subject: ${encodeHeaderWord(message.subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(Buffer.from(message.body, 'utf8').toString('base64')),
    ];
    for (const att of message.attachments ?? []) {
      parts.push(
        `--${boundary}`,
        `Content-Type: ${att.contentType}; name="${att.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${att.filename}"`,
        '',
        wrap76(att.content.toString('base64')),
      );
    }
    parts.push(`--${boundary}--`, '');
    return Buffer.from(parts.join('\r\n'), 'utf8');
  }

  async sendSms(message: SmsMessage): Promise<void> {
    this.logger.log(
      { channel: 'sms', to: message.to, length: message.body.length },
      'SMS not delivered — no SMS provider is wired (SES channel handles email only)',
    );
  }
}
