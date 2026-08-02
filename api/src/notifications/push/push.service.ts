import { isIP } from 'net';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscribePushDto } from './dto/subscribe-push.dto';
import { isBlockedAddress } from '../../common/net/safe-fetch';

export interface PushPayload {
  title: string;
  body?: string;
  linkPath?: string;
}

/**
 * Browser-native Web Push — unlike email/SMS this needs no third-party
 * account: the VAPID keypair is generated locally (`npx web-push
 * generate-vapid-keys`) and delivery goes through the browser's own push
 * service. Configured only if VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are set
 * (see .env.example); with no keys, this degrades to a no-op rather than
 * the app failing to start.
 *
 * PushSubscription has no RLS (same reasoning as `users`), so every query
 * here goes through `this.prisma` directly — no `withTenant`.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly publicKey: string | null;
  private readonly configured: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const publicKey = config.get<string>('VAPID_PUBLIC_KEY');
    const privateKey = config.get<string>('VAPID_PRIVATE_KEY');
    const subject = config.get<string>('VAPID_SUBJECT') ?? 'mailto:support@example.com';
    this.configured = !!publicKey && !!privateKey;
    this.publicKey = publicKey || null;
    if (this.configured) {
      webpush.setVapidDetails(subject, publicKey!, privateKey!);
    }
  }

  getPublicKey(): string | null {
    return this.publicKey;
  }

  async subscribe(userId: string, dto: SubscribePushDto): Promise<void> {
    // The endpoint is a client-supplied URL the server later POSTs to (via
    // web-push). Reject the obvious SSRF targets (localhost, private/loopback IP
    // literals, bad scheme, embedded creds) so a subscription can't point the
    // server at internal/metadata URLs. Syntactic only (no live DNS lookup):
    // this value is stored, not fetched here, and a real push endpoint is always
    // an https URL on a public push service.
    this.assertEndpointAllowed(dto.endpoint);
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      update: { userId, p256dh: dto.keys.p256dh, auth: dto.keys.auth },
      create: { userId, endpoint: dto.endpoint, p256dh: dto.keys.p256dh, auth: dto.keys.auth },
    });
  }

  /**
   * Syntactic SSRF guard for a stored push endpoint: http(s) only, no embedded
   * credentials, no localhost/`*.localhost`, and no private/loopback/link-local
   * IP literal (reusing the same blocklist as safeFetch). Deliberately does no
   * DNS resolution — a hostname is validated at send time by web-push, and this
   * only needs to stop the endpoint being an obviously-internal URL before it's
   * persisted.
   */
  private assertEndpointAllowed(endpoint: string): void {
    const reject = () =>
      new BadRequestException({ code: 'INVALID_PUSH_ENDPOINT', message: 'The push endpoint is not an allowed URL.' });
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw reject();
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw reject();
    if (url.username || url.password) throw reject();
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost')) throw reject();
    // Only literal IPs are checked here (isIP > 0); a hostname is left to
    // resolve at send time — no DNS lookup happens in this path.
    if (isIP(host) && isBlockedAddress(host)) throw reject();
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  }

  /**
   * Fire-and-forget by design: called from inside NotificationsService's
   * `*InTx` methods, which run inside the caller's own DB transaction — this
   * must never be awaited there, or a slow/failed push would hold that
   * transaction open (or roll back a notification that has nothing to do
   * with whether a push delivered). Known, deliberate v0 trade-off: in the
   * rare case the surrounding transaction later rolls back, a push may still
   * have gone out for a notification that didn't end up persisting.
   */
  notifyUser(userId: string, payload: PushPayload): void {
    if (!this.configured) return;
    void this.sendToUser(userId, payload).catch((err) => this.logger.warn(`Push delivery failed for user ${userId}: ${err}`));
  }

  private async sendToUser(userId: string, payload: PushPayload): Promise<void> {
    const subscriptions = await this.prisma.pushSubscription.findMany({ where: { userId } });
    if (subscriptions.length === 0) return;
    const body = JSON.stringify(payload);
    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body);
        } catch (err) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            // Expired/unregistered subscription — the browser will never accept
            // another push at this endpoint, so stop trying.
            await this.prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => undefined);
          } else {
            throw err;
          }
        }
      }),
    );
  }
}
