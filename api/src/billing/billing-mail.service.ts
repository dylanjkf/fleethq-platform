import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NOTIFICATION_CHANNEL, type NotificationChannel } from '../notifications/channels/notification-channel';

/**
 * Billing email notifications (Auth/Billing Platform Phase 6) — the email
 * companion to the in-app `billing.payment_failed`/`billing.payment_recovered`
 * notifications `BillingService` already raises via `NotificationsService`.
 * Mirrors `AuthMailService`'s shape: one method per email, through the same
 * `NotificationChannel` abstraction (real SES when configured, log-only
 * otherwise) — no new email infrastructure.
 */
@Injectable()
export class BillingMailService {
  constructor(
    @Inject(NOTIFICATION_CHANNEL) private readonly channel: NotificationChannel,
    private readonly config: ConfigService,
  ) {}

  private billingSettingsLink(): string {
    return `${this.config.get<string>('APP_BASE_URL', 'http://localhost:5173').replace(/\/$/, '')}/billing`;
  }

  async sendPaymentFailed(to: string, fullName: string, companyName: string, nextAttempt: Date | null): Promise<void> {
    const retryLine = nextAttempt
      ? `Stripe will automatically retry the charge on ${nextAttempt.toLocaleDateString('en-AU')}.`
      : `Stripe was unable to schedule an automatic retry.`;
    await this.channel.sendEmail({
      to,
      subject: `Payment failed for ${companyName}'s FleetOS subscription`,
      body: `Hi ${fullName},\n\nWe were unable to charge the payment method on file for ${companyName}'s FleetOS subscription.\n\n${retryLine} Update your payment method to avoid an interruption:\n\n${this.billingSettingsLink()}\n\nIf you believe this is an error, check your card details or contact your bank.`,
    });
  }

  async sendPaymentRecovered(to: string, fullName: string, companyName: string): Promise<void> {
    await this.channel.sendEmail({
      to,
      subject: `Payment received — ${companyName}'s FleetOS subscription is back in good standing`,
      body: `Hi ${fullName},\n\nYour most recent payment for ${companyName}'s FleetOS subscription succeeded, and the account is no longer past due.\n\n${this.billingSettingsLink()}`,
    });
  }
}
