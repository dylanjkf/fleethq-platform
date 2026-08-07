import { createHash } from 'crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { safeFetch } from '../common/net/safe-fetch';

/**
 * Breached-password screening (security audit M1). The composition rule
 * (IsStrongPassword: ≥8 chars, 2 of 4 classes, small denylist) still lets
 * through passwords near the top of every real breach corpus — `Password1!`,
 * `Summer2025!`. This adds a Have I Been Pwned k-anonymity check as a second
 * layer, applied wherever a user *chooses* a password (signup, self-service
 * change, reset).
 *
 * k-anonymity: only the first 5 hex chars of the password's SHA-1 leave the
 * server; HIBP returns every breached suffix under that prefix and the match is
 * done locally, so the full password and full hash never go over the wire. The
 * request goes through safeFetch (SSRF-guarded, https-only, pinned) like every
 * other outbound call here.
 *
 * Fails **open**: if HIBP is unreachable or errors, we log and allow the
 * password rather than blocking a signup/reset on a third-party outage. The
 * composition rule and reuse check still apply regardless.
 */
@Injectable()
export class BreachedPasswordService {
  private readonly logger = new Logger(BreachedPasswordService.name);
  private static readonly RANGE_API = 'https://api.pwnedpasswords.com/range';

  /** Throws PASSWORD_BREACHED if the password appears in the HIBP corpus; no-op (fail-open) if HIBP can't be reached. */
  async assertNotBreached(password: string): Promise<void> {
    if (typeof password !== 'string' || password.length === 0) return;
    // The offline e2e suite has no external egress and reuses a weak shared test
    // password; a real HIBP call would either hang or flag it. Skip the network
    // call there. The check runs in every real environment; the unit test
    // (breached-password.service.spec) forces it on to prove the logic.
    if (process.env.NODE_ENV === 'test' && process.env.HIBP_CHECK_IN_TEST !== 'true') return;

    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    let body: string;
    try {
      const res = await safeFetch(`${BreachedPasswordService.RANGE_API}/${prefix}`, {
        // Add-Padding makes HIBP return a padded, fixed-ish-size list (some
        // entries with count 0) so response size can't reveal how many real
        // hits share the prefix — hence the count>0 check below.
        headers: { 'Add-Padding': 'true', 'User-Agent': 'FleetHQ-security/1.0' },
      });
      if (!res.ok) {
        this.logger.warn(`HIBP range API returned ${res.status}; allowing password (fail-open).`);
        return;
      }
      body = await res.text();
    } catch (err) {
      this.logger.warn(`HIBP range API unreachable; allowing password (fail-open): ${err}`);
      return;
    }

    for (const line of body.split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const hashSuffix = line.slice(0, idx).trim().toUpperCase();
      const count = Number(line.slice(idx + 1).trim());
      if (hashSuffix === suffix && count > 0) {
        throw new BadRequestException({
          code: 'PASSWORD_BREACHED',
          message: 'This password has appeared in a known data breach. Please choose a different one.',
        });
      }
    }
  }
}
