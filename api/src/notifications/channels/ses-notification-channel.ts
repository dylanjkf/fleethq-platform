import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import type { EmailMessage, NotificationChannel, SmsMessage } from './notification-channel';

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

  async sendSms(message: SmsMessage): Promise<void> {
    this.logger.log(
      { channel: 'sms', to: message.to, length: message.body.length },
      'SMS not delivered — no SMS provider is wired (SES channel handles email only)',
    );
  }
}
