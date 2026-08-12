import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NOTIFICATION_CHANNEL, type NotificationChannel } from '../notifications/channels/notification-channel';

/**
 * The admin console's equivalent of AuthMailService — sends the FleetHQ
 * *staff* admin security emails through the same `NotificationChannel` the
 * rest of the app uses (real AWS SES when configured, logging-only
 * otherwise), so no new email infrastructure is introduced. Link targets are
 * built from `APP_BASE_URL` plus the admin SPA's `/admin/` base path (the app
 * is served under that prefix — see the admin frontend's vite `base`), so the
 * review-sessions link lands on the admin console's own settings page rather
 * than the customer app.
 */
@Injectable()
export class AdminAuthMailService {
  constructor(
    @Inject(NOTIFICATION_CHANNEL) private readonly channel: NotificationChannel,
    private readonly config: ConfigService,
  ) {}

  private baseUrl(): string {
    return this.config.get<string>('APP_BASE_URL', 'http://localhost:5173').replace(/\/$/, '');
  }

  private sessionsUrl(): string {
    // The admin SPA is served under `/admin/`; its active-sessions review +
    // revoke UI lives on the settings page (SettingsPage's SessionsCard).
    return `${this.baseUrl()}/admin/settings`;
  }

  private resetUrl(token: string): string {
    // The admin SPA's reset screen (built in the client pass) reads the raw
    // token from the query string. The raw token is base64url, so it needs no
    // extra encoding here.
    return `${this.baseUrl()}/admin/reset-password?token=${token}`;
  }

  /**
   * Best-effort security alert — fires when a FleetHQ staff admin signs in
   * from an IP + user-agent pair the account hasn't been seen on before. Tells
   * the admin owner what happened, roughly when, and links to the session
   * review/revoke page so they can shut down the session if it wasn't them.
   * Fire-and-forget at the call site (mirrors AuthMailService.sendNewDeviceLogin):
   * a slow or failed email must never block or roll back a login.
   */
  async sendNewDeviceLogin(
    to: string,
    fullName: string,
    context: { ip?: string | null; userAgent?: string | null; when?: Date },
  ): Promise<void> {
    const when = context.when ?? new Date();
    const whenText = `${when.toLocaleTimeString('en-AU')} on ${when.toLocaleDateString('en-AU')}`;
    await this.channel.sendEmail({
      to,
      subject: 'New sign-in to your FleetHQ admin account',
      body:
        `Hi ${fullName},\n\n` +
        `We noticed a sign-in to your FleetHQ admin console account from a device we haven't seen before.\n\n` +
        `When: ${whenText}\n` +
        `IP address: ${context.ip ?? 'unknown'}` +
        (context.userAgent ? `\nDevice: ${context.userAgent}` : '') +
        `\n\nIf this was you, no action is needed. If you don't recognise this activity, review and revoke your active sessions here:\n\n` +
        `${this.sessionsUrl()}\n\n` +
        `and change your password immediately.`,
    });
  }

  /**
   * The self-service password-reset link — admin-side mirror of
   * AuthMailService.sendPasswordReset. Carries the single-use, one-hour token
   * to the admin console's own reset screen (`/admin/reset-password`). Only
   * ever sent to an address already on file for a real admin (the
   * forgot-password flow is silent/non-enumerating otherwise).
   */
  async sendPasswordReset(to: string, fullName: string, token: string): Promise<void> {
    await this.channel.sendEmail({
      to,
      subject: 'Reset your FleetHQ admin password',
      body:
        `Hi ${fullName},\n\n` +
        `We received a request to reset the password for your FleetHQ admin console account.\n\n` +
        `Reset your password using the link below (it expires in 1 hour and can be used once):\n\n` +
        `${this.resetUrl(token)}\n\n` +
        `If you didn't request this, you can safely ignore this email — your password won't change.`,
    });
  }

  /**
   * Confirmation that the password was changed — best-effort, sent after a
   * completed reset so the owner notices an unexpected change. Mirrors
   * AuthMailService.sendPasswordChanged.
   */
  async sendPasswordChanged(to: string, fullName: string): Promise<void> {
    await this.channel.sendEmail({
      to,
      subject: 'Your FleetHQ admin password was changed',
      body:
        `Hi ${fullName},\n\n` +
        `The password for your FleetHQ admin console account was just changed.\n\n` +
        `If this was you, no action is needed. If you don't recognise this change, contact your FleetHQ administrator immediately — ` +
        `all of your existing admin sessions have been signed out as a precaution.`,
    });
  }
}
