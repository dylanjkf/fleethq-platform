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

  private sessionsUrl(): string {
    const base = this.config.get<string>('APP_BASE_URL', 'http://localhost:5173').replace(/\/$/, '');
    // The admin SPA is served under `/admin/`; its active-sessions review +
    // revoke UI lives on the settings page (SettingsPage's SessionsCard).
    return `${base}/admin/settings`;
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
}
