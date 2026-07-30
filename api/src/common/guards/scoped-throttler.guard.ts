import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Per-session throttling instead of the stock guard's per-IP.
 *
 * The default ThrottlerGuard keys every bucket on `req.ip`. That breaks a real
 * FleetOS scenario: many DriverOS devices behind one depot's shared WiFi egress
 * IP would share a single bucket, so when their offline outboxes flush (POD
 * photos, damage reports) the legitimate uploads 429 each other.
 *
 * This guard runs FIRST in the chain (before JwtAuthGuard), so `req.user` isn't
 * populated yet — but the bearer token already is. We key authenticated
 * requests on a hash of that token, giving each signed-in session its own
 * bucket. Requests with no bearer token (login, signup, GPS device ingest) fall
 * back to `req.ip`, which is exactly what brute-force protection wants.
 *
 * NOTE: the throttler store is still in-memory per instance, so under
 * horizontal scaling the effective ceiling is `limit × instance-count`. The
 * WAF's distributed per-IP rule is the backstop for truly distributed abuse.
 */
@Injectable()
export class ScopedThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const auth = (req.headers as Record<string, unknown> | undefined)?.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      // Hash so the raw token never becomes a map key / shows up in memory dumps.
      return `tok:${createHash('sha256').update(auth.slice(7)).digest('hex')}`;
    }
    const ip = typeof req.ip === 'string' ? req.ip : 'unknown';
    return `ip:${ip}`;
  }
}
