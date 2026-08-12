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

  async sendPaymentFailed(to: string, fullName: string, companyName: string, nextAttempt: Date | null, graceEndsAt: Date | null): Promise<void> {
    const retryLine = nextAttempt
      ? `Stripe will automatically retry the charge on ${nextAttempt.toLocaleDateString('en-AU')}.`
      : `Stripe was unable to schedule an automatic retry.`;
    const graceLine = graceEndsAt
      ? `Your account stays fully active until ${graceEndsAt.toLocaleDateString('en-AU')} — a 5 business-day grace period. Update your payment method before then to avoid any restriction to your account.`
      : `Update your payment method to avoid an interruption.`;
    await this.channel.sendEmail({
      to,
      subject: `Payment failed for ${companyName}'s FleetOS subscription`,
      body: `Hi ${fullName},\n\nWe were unable to charge the payment method on file for ${companyName}'s FleetOS subscription.\n\n${retryLine} ${graceLine}\n\n${this.billingSettingsLink()}\n\nIf you believe this is an error, check your card details or contact your bank.`,
    });
  }

  async sendPaymentRecovered(to: string, fullName: string, companyName: string): Promise<void> {
    await this.channel.sendEmail({
      to,
      subject: `Payment received — ${companyName}'s FleetOS subscription is back in good standing`,
      body: `Hi ${fullName},\n\nYour most recent payment for ${companyName}'s FleetOS subscription succeeded, and the account is no longer past due.\n\n${this.billingSettingsLink()}`,
    });
  }

  /**
   * Native (no-card) free-trial ending reminder — the email companion to the
   * scheduled `BillingService.remindTrialEnding` in-app notification. Sent once
   * per trial window (the notification marker guards against repeats).
   */
  async sendTrialEndingReminder(to: string, fullName: string, companyName: string, trialEndsAt: Date): Promise<void> {
    await this.channel.sendEmail({
      to,
      subject: `${companyName}'s FleetOS free trial ends on ${trialEndsAt.toLocaleDateString('en-AU')}`,
      body: `Hi ${fullName},\n\n${companyName}'s FleetOS free trial ends on ${trialEndsAt.toLocaleDateString('en-AU')}. Choose a plan before then to keep full access to your fleet — nothing is deleted, but paid features become unavailable once the trial ends.\n\n${this.billingSettingsLink()}`,
    });
  }

  /**
   * Stripe-trial (card-on-file) conversion reminder — the email companion to the
   * `customer.subscription.trial_will_end` webhook notification. Distinct from
   * the native reminder above: here a payment method is on file and will be
   * charged when the trial converts.
   */
  async sendTrialWillEnd(to: string, fullName: string, companyName: string, trialEnd: Date | null): Promise<void> {
    const whenLine = trialEnd
      ? `The trial ends on ${trialEnd.toLocaleDateString('en-AU')}, after which your payment method on file will be charged.`
      : `The trial is ending soon, after which your payment method on file will be charged.`;
    await this.channel.sendEmail({
      to,
      subject: `${companyName}'s FleetOS trial is ending soon`,
      body: `Hi ${fullName},\n\n${whenLine} Review your plan or update your payment details if anything needs to change.\n\n${this.billingSettingsLink()}`,
    });
  }

  /**
   * Subscription-paused notice — the email companion to the
   * `customer.subscription.paused` webhook notification.
   */
  async sendSubscriptionPaused(to: string, fullName: string, companyName: string): Promise<void> {
    await this.channel.sendEmail({
      to,
      subject: `${companyName}'s FleetOS subscription has been paused`,
      body: `Hi ${fullName},\n\n${companyName}'s FleetOS subscription is currently paused and will not be billed until it resumes. Some paid features may be unavailable while it is paused.\n\nIf this was unexpected, review your billing settings or get in touch:\n\n${this.billingSettingsLink()}`,
    });
  }

  /**
   * Chargeback / payment-dispute alert — the URGENT email companion to the
   * `charge.dispute.created` webhook notification. Disputes are time-boxed by
   * Stripe, so this must reach billing:manage holders, not sit silently in-app.
   */
  async sendDisputeCreated(to: string, fullName: string, companyName: string, amount: string, dueBy: Date | null): Promise<void> {
    const deadlineLine = dueBy
      ? `Evidence must be submitted in Stripe before ${dueBy.toLocaleDateString('en-AU')}`
      : `Evidence must be submitted in Stripe before the response deadline`;
    await this.channel.sendEmail({
      to,
      subject: `Urgent: a ${amount} payment for ${companyName} was disputed`,
      body: `Hi ${fullName},\n\nA cardholder has disputed a ${amount} payment on ${companyName}'s FleetOS account (a chargeback). ${deadlineLine}, or the disputed amount plus a dispute fee will be lost.\n\nReview and respond from your Stripe dashboard as soon as possible.\n\n${this.billingSettingsLink()}`,
    });
  }
}
