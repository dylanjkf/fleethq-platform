import { Injectable, Logger } from '@nestjs/common';
import type { EmailMessage, NotificationChannel, SmsMessage } from './notification-channel';

/**
 * Default `NotificationChannel` — no real email/SMS provider account exists
 * yet, so this records what WOULD have been sent (structured log line) and
 * does not actually deliver anything. Every notification still lands and
 * persists in-app/in the digest either way; this only stands in for the
 * "and also actually emailed/texted them" step.
 */
@Injectable()
export class LoggingNotificationChannel implements NotificationChannel {
  private readonly logger = new Logger('NotificationChannel');

  async sendEmail(message: EmailMessage): Promise<void> {
    this.logger.log(
      {
        channel: 'email',
        to: message.to,
        subject: message.subject,
        attachments: message.attachments?.map((a) => ({ filename: a.filename, bytes: a.content.length })),
      },
      'Simulated email (no provider configured)',
    );
  }

  async sendSms(message: SmsMessage): Promise<void> {
    this.logger.log({ channel: 'sms', to: message.to, length: message.body.length }, 'Simulated SMS (no provider configured)');
  }
}
