import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NOTIFICATION_CHANNEL, type NotificationChannel } from '../notifications/channels/notification-channel';
import { CreateContactMessageDto } from './dto/create-contact-message.dto';

const DEFAULT_CONTACT_EMAIL_TO = 'admin@fleethq.net.au';

/**
 * FleetHQ has no self-service signup/free-trial — a prospective customer's
 * only path in is this public enquiry form, reached from the sign-in page
 * (see fleethq-frontend's LoginPage + ContactPage). Reuses the same
 * NotificationChannel every other outbound email in this codebase goes
 * through (SES in production, logging-only in dev/CI) rather than a
 * separate mail path.
 */
@Injectable()
export class ContactService {
  constructor(
    @Inject(NOTIFICATION_CHANNEL) private readonly channel: NotificationChannel,
    private readonly config: ConfigService,
  ) {}

  async submit(dto: CreateContactMessageDto): Promise<{ received: true }> {
    const to = this.config.get<string>('CONTACT_EMAIL_TO') || DEFAULT_CONTACT_EMAIL_TO;

    await this.channel.sendEmail({
      to,
      subject: `FleetHQ enquiry from ${dto.name}`,
      body: `Name: ${dto.name}\nEmail: ${dto.email}\n\n${dto.message}`,
    });

    return { received: true };
  }
}
