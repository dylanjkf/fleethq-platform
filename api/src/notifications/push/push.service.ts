import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscribePushDto } from './dto/subscribe-push.dto';
import { assertUrlAllowed, safeFetch, SsrfBlockedError } from '../../common/net/safe-fetch';

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
    // The endpoint is a client-supplied URL the server later POSTs to. Validate
    // it the same way as every other user-influenced outbound request in this
    // codebase: resolve its DNS and reject if it (or any address it resolves to)
    // is an internal / loopback / link-local / cloud-metadata target. Rejecting
    // here — not just at send time — stops a hostile subscription from ever
    // being persisted. Send time re-validates again (see sendToUser) to close
    // the DNS-rebinding window between subscribe and delivery.
    await this.assertEndpointAllowed(dto.endpoint);
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      update: { userId, p256dh: dto.keys.p256dh, auth: dto.keys.auth },
      create: { userId, endpoint: dto.endpoint, p256dh: dto.keys.p256dh, auth: dto.keys.auth },
    });
  }

  /**
   * SSRF guard for a client-supplied push endpoint. Rejects non-http(s) schemes
   * and embedded credentials syntactically, then hands off to the shared
   * {@link assertUrlAllowed} — the exact resolve-then-blocklist check safeFetch
   * uses — so a hostname that *resolves* to an internal/metadata address is
   * refused, not just a literal internal IP. Maps the shared SsrfBlockedError to
   * the endpoint's own 400 contract.
   */
  private async assertEndpointAllowed(endpoint: string): Promise<void> {
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
    // The offline e2e suite has no external DNS egress and registers endpoints
    // on the reserved `.test` TLD (never resolvable), so skip the live-DNS
    // resolution there — the syntactic checks above still run. The resolve+
    // blocklist check runs in every real environment; the unit test
    // (push.service.spec) forces it on to prove the resolution path.
    if (process.env.NODE_ENV === 'test' && process.env.PUSH_SSRF_CHECK_IN_TEST !== 'true') return;
    try {
      // Resolves DNS and blocklists every resolved address (RFC1918, loopback,
      // link-local incl. 169.254.169.254, NAT64-embedded metadata, etc.).
      await assertUrlAllowed(endpoint);
    } catch (err) {
      if (err instanceof SsrfBlockedError) throw reject();
      throw err;
    }
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
    await Promise.all(subscriptions.map((sub) => this.deliver(sub, body)));
  }

  /**
   * Deliver one push. `web-push` does all the ECDH/VAPID encryption but its own
   * `sendNotification` fires a raw https request with no SSRF protection — so we
   * use `generateRequestDetails` to build the encrypted request *without*
   * sending, then push it out through {@link safeFetch}, which re-resolves and
   * blocklists the host, pins the socket to the validated IP (closing the
   * DNS-rebinding window between subscribe time and now), and re-validates every
   * redirect hop. A host that has since rebound to an internal address raises
   * SsrfBlockedError and is skipped, never delivered.
   */
  private async deliver(sub: { id: string; endpoint: string; p256dh: string; auth: string }, body: string): Promise<void> {
    let request: { endpoint: string; body: string | Buffer; headers: Record<string, string | number> };
    try {
      request = webpush.generateRequestDetails(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
      ) as typeof request;
    } catch (err) {
      this.logger.warn(`Skipping push to ${sub.endpoint}: could not build request (${err})`);
      return;
    }

    // web-push emits numeric headers (TTL, Content-Length); normalise to strings.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) headers[k] = String(v);
    // The encrypted body is a Buffer; expose it as a Uint8Array view (a valid
    // BodyInit) — safeFetch writes it to the wire unchanged.
    const outBody = typeof request.body === 'string' ? request.body : new Uint8Array(request.body);

    try {
      const res = await safeFetch(request.endpoint, { method: 'POST', headers, body: outBody });
      if (res.status === 404 || res.status === 410) {
        // Expired/unregistered subscription — the push service will never accept
        // another delivery here, so stop trying.
        await this.prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => undefined);
      } else if (!res.ok) {
        this.logger.warn(`Push to ${sub.endpoint} returned ${res.status}`);
      }
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        // The endpoint host now resolves to an internal address (rebind or a
        // subscription created before this guard existed). Refuse to deliver.
        this.logger.warn(`Refusing push to ${sub.endpoint}: ${err.message}`);
        return;
      }
      throw err;
    }
  }
}
