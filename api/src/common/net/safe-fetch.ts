import { lookup } from 'dns';
import { isIP } from 'net';
import { promisify } from 'util';

const dnsLookup = promisify(lookup);

const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Raised when a tenant-supplied URL is refused before any request is made
 * (bad scheme, unresolvable host, or a host that resolves to an internal /
 * loopback / link-local / cloud-metadata address). Callers turn this into a
 * clean 4xx rather than letting the underlying fetch surprise them.
 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * CIDR blocks a tenant-supplied URL must never reach, as
 * [network-as-uint32, prefix-length]. Covers loopback, all RFC1918 private
 * ranges, CGNAT, link-local (incl. the 169.254.169.254 cloud-metadata
 * endpoint), benchmarking, multicast, and reserved space.
 */
const BLOCKED_IPV4_CIDRS: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10.0.0.0/8 RFC1918
  [0x64400000, 10], // 100.64.0.0/10 CGNAT
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local (incl. metadata)
  [0xac100000, 12], // 172.16.0.0/12 RFC1918
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
  [0xc0a80000, 16], // 192.168.0.0/16 RFC1918
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xe0000000, 3], // 224.0.0.0/3 multicast + reserved + broadcast (covers 224–255)
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isBlockedIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true;
  return BLOCKED_IPV4_CIDRS.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((value & mask) >>> 0) === ((network & mask) >>> 0);
  });
}

/** First-hextet ranges [lo, hi] a tenant-supplied IPv6 URL must never reach. */
const BLOCKED_IPV6_FIRST_GROUP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0xfc00, 0xfdff], // fc00::/7 unique-local
  [0xfe80, 0xfebf], // fe80::/10 link-local
  [0xff00, 0xffff], // ff00::/8 multicast
];

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d) — validate the embedded v4.
  const embedded = lower.match(/(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) return isBlockedIPv4(embedded[1]);
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  const firstGroup = parseInt(lower.split(':')[0] || '0', 16) || 0;
  return BLOCKED_IPV6_FIRST_GROUP_RANGES.some(([lo, hi]) => firstGroup >= lo && firstGroup <= hi);
}

/** True if `ip` is an address a tenant-supplied URL must never be allowed to reach. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true; // not a parseable IP → refuse rather than guess
}

/**
 * Validate a tenant-supplied URL for outbound fetching: http(s) only, and its
 * host must not resolve to any internal / loopback / link-local / metadata
 * address. Returns the parsed URL on success; throws {@link SsrfBlockedError}
 * otherwise.
 *
 * Known limitation: this is resolve-then-fetch, so a determined attacker who
 * controls an authoritative DNS server could in principle rebind the name to
 * a private address in the window between this check and the socket connect
 * (a classic TOCTOU). That does not open the concrete exploits this guard is
 * for — a literal metadata IP, an internal hostname, or `localhost` are all
 * caught here because they don't rebind. Closing the rebinding window fully
 * would require pinning the validated IP into the connection (a custom
 * dispatcher), deliberately deferred to avoid taking on that dependency.
 */
export async function assertUrlAllowed(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('The URL is malformed.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`Only http and https URLs are allowed (got "${url.protocol}").`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new SsrfBlockedError('The URL has no host.');

  let resolved: { address: string }[];
  try {
    resolved = await dnsLookup(host, { all: true, verbatim: true });
  } catch {
    throw new SsrfBlockedError(`The URL host "${host}" could not be resolved.`);
  }
  if (resolved.length === 0) throw new SsrfBlockedError(`The URL host "${host}" did not resolve to any address.`);
  for (const { address } of resolved) {
    if (isBlockedAddress(address)) {
      throw new SsrfBlockedError(`The URL host "${host}" resolves to a blocked internal address.`);
    }
  }
  return url;
}

/**
 * A drop-in `fetch` for tenant-supplied URLs. Validates the target (and every
 * redirect hop) against {@link assertUrlAllowed} before the request is made,
 * following redirects manually so a same-origin-looking URL cannot be
 * server-side-redirected to an internal target. Throws {@link SsrfBlockedError}
 * for a disallowed target and for exceeding the redirect budget.
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}, maxRedirects = DEFAULT_MAX_REDIRECTS): Promise<Response> {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertUrlAllowed(currentUrl);
    const response = await fetch(currentUrl, { ...init, redirect: 'manual' });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (!location) return response;
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw new SsrfBlockedError(`The URL exceeded the maximum of ${maxRedirects} redirects.`);
}
