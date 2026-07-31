import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NOTIFICATION_CHANNEL, type NotificationChannel } from '../notifications/channels/notification-channel';

/**
 * Sends the transactional auth emails (verification, password reset, invite)
 * through the same `NotificationChannel` the rest of the app uses — real AWS
 * SES when configured, logging-only otherwise. Link targets are built from
 * `APP_BASE_URL` (the FleetHQ origin); with no email provider configured this
 * degrades to logging the link, which is exactly what local dev/CI want.
 */
@Injectable()
export class AuthMailService {
  constructor(
    @Inject(NOTIFICATION_CHANNEL) private readonly channel: NotificationChannel,
    private readonly config: ConfigService,
  ) {}

  private baseUrl(): string {
    return this.config.get<string>('APP_BASE_URL', 'http://localhost:5173').replace(/\/$/, '');
  }

  async sendVerification(to: string, fullName: string, token: string): Promise<void> {
    const link = `${this.baseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
    await this.channel.sendEmail({
      to,
      subject: 'Verify your FleetOS email',
      body: `Hi ${fullName},\n\nConfirm your email address to finish setting up your FleetOS account:\n\n${link}\n\nThis link expires in 24 hours. If you didn't create a FleetOS account, you can ignore this email.`,
    });
  }

  async sendMagicLink(to: string, fullName: string, token: string): Promise<void> {
    const link = `${this.baseUrl()}/magic-link?token=${encodeURIComponent(token)}`;
    await this.channel.sendEmail({
      to,
      subject: 'Your FleetOS sign-in link',
      body: `Hi ${fullName},\n\nClick this link to sign in to FleetOS — no password needed:\n\n${link}\n\nThis link expires in 15 minutes and can only be used once. If you didn't request this, you can ignore this email.`,
    });
  }

  async sendPasswordReset(to: string, fullName: string, token: string): Promise<void> {
    const link = `${this.baseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
    await this.channel.sendEmail({
      to,
      subject: 'Reset your FleetOS password',
      body: `Hi ${fullName},\n\nWe received a request to reset your FleetOS password. Choose a new one here:\n\n${link}\n\nThis link expires in 1 hour. If you didn't request this, no action is needed — your password is unchanged.`,
    });
  }

  /** Best-effort security alert — fires when a login presents a device
   *  fingerprint that isn't yet a recognised trusted device for that user. */
  async sendNewDeviceLogin(to: string, fullName: string, context: { ip?: string | null; userAgent?: string | null }): Promise<void> {
    await this.channel.sendEmail({
      to,
      subject: 'New sign-in to your FleetOS account',
      body: `Hi ${fullName},\n\nWe noticed a sign-in to your FleetOS account from a device we haven't seen before.\n\nIP address: ${context.ip ?? 'unknown'}${context.userAgent ? `\nDevice: ${context.userAgent}` : ''}\n\nIf this was you, no action is needed. If you don't recognise this activity, reset your password immediately from the sign-in page.`,
    });
  }

  async sendInvite(to: string, fullName: string, companyName: string, token: string): Promise<void> {
    const link = `${this.baseUrl()}/reset-password?token=${encodeURIComponent(token)}&invite=1`;
    await this.channel.sendEmail({
      to,
      subject: `You've been invited to ${companyName} on FleetOS`,
      body: `Hi ${fullName},\n\nYou've been given a FleetOS login for ${companyName}. Set your password to get started:\n\n${link}\n\nThis link expires in 1 hour.`,
    });
  }

  /**
   * Auth/Billing Platform Phase 6: confirmation that a password was actually
   * changed — distinct from `sendPasswordReset`, which sends the *link* that
   * starts a reset. Fires from every path that ends in a new password hash
   * (self-service change, a completed reset, and a policy-forced expiry
   * change), so an account holder who didn't make the change has a signal to
   * act on even if they never asked for a reset link.
   */
  async sendPasswordChanged(to: string, fullName: string): Promise<void> {
    await this.channel.sendEmail({
      to,
      subject: 'Your FleetOS password was changed',
      body: `Hi ${fullName},\n\nYour FleetOS account password was just changed.\n\nIf this was you, no action is needed. If you didn't make this change, contact your company administrator immediately — your account may be compromised.`,
    });
  }

  async sendMfaEnabled(to: string, fullName: string): Promise<void> {
    await this.channel.sendEmail({
      to,
      subject: 'Two-factor authentication was enabled on your FleetOS account',
      body: `Hi ${fullName},\n\nTwo-factor authentication (TOTP) was just enabled on your FleetOS account, and a set of one-time backup codes was issued.\n\nIf this was you, no action is needed. If you didn't do this, contact your company administrator immediately.`,
    });
  }

  /** MFA being turned off is a higher-value alert than being turned on — it's a classic step in an account takeover. */
  async sendMfaDisabled(to: string, fullName: string): Promise<void> {
    await this.channel.sendEmail({
      to,
      subject: 'Two-factor authentication was disabled on your FleetOS account',
      body: `Hi ${fullName},\n\nTwo-factor authentication was just turned off on your FleetOS account.\n\nIf this was you, no action is needed. If you didn't do this, contact your company administrator immediately — your account may be compromised, and re-enabling MFA is strongly recommended.`,
    });
  }

  /** Best-effort security alert — fires when repeated failed logins lock an account (a credential-stuffing/brute-force indicator). */
  async sendAccountLocked(to: string, fullName: string, unlockAt: Date): Promise<void> {
    await this.channel.sendEmail({
      to,
      subject: 'Your FleetOS account was temporarily locked',
      body: `Hi ${fullName},\n\nYour FleetOS account was temporarily locked after several failed sign-in attempts. It will unlock automatically at ${unlockAt.toLocaleTimeString('en-AU')} on ${unlockAt.toLocaleDateString('en-AU')}, or you can reset your password to unlock it sooner.\n\nIf this wasn't you, someone may be trying to guess your password — consider resetting it once the lock clears.`,
    });
  }
}
