import * as dns from 'dns';
import type { LookupAddress } from 'dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'net';
import type { LookupFunction } from 'net';
import { promisify } from 'util';

/**
 * Resolve `dns.lookup` at call time (rather than capturing it once at import)
 * so the resolver is always the live one — this keeps the SSRF check honest if
 * anything reconfigures DNS at runtime, and lets tests stub `dns.lookup` to
 * assert the resolve-then-blocklist path (a hostname resolving to an internal
 * address) without real network I/O. Behaviour is otherwise identical: with
 * `{ all: true }` the promisified form returns the full `LookupAddress[]`.
 */
function dnsLookup(host: string, options: { all: true; verbatim: boolean }): Promise<LookupAddress[]> {
  return promisify(dns.lookup)(host, options) as unknown as Promise<LookupAddress[]>;
}

const DEFAULT_MAX_REDIRECTS = 5;

/** Socket-level timeout for a single outbound request hop. */
const SOCKET_TIMEOUT_MS = 10_000;

/** Statuses that a `Response` is forbidden from carrying a body for. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

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

/**
 * Expand an IPv6 literal (already known to be a valid v6 address) into its
 * eight 16-bit hextets, resolving `::` compression and folding any trailing
 * dotted-quad IPv4 tail into the low two hextets. Returns null if it can't be
 * parsed cleanly. Used to decode addresses that embed an IPv4 in their low
 * bits (NAT64) so the embedded v4 can be re-checked against the v4 blocklist.
 */
function ipv6ToHextets(ip: string): number[] | null {
  let s = ip.split('%')[0]; // drop any zone id
  // Fold a trailing dotted-quad (e.g. ...::169.254.169.254) into two hextets.
  const v4 = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    if (n === null) return null;
    const hi = (n >>> 16) & 0xffff;
    const lo = n & 0xffff;
    s = s.slice(0, v4.index) + hi.toString(16) + ':' + lo.toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const tail = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (g === '' ? 0 : parseInt(g, 16)));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

/**
 * If `ip` sits under the well-known NAT64 prefix `64:ff9b::/96`, return the
 * IPv4 address embedded in its low 32 bits (e.g. `64:ff9b::a9fe:a9fe` and
 * `64:ff9b::169.254.169.254` both → "169.254.169.254"); otherwise null.
 */
function nat64EmbeddedIPv4(ip: string): string | null {
  const groups = ipv6ToHextets(ip);
  if (!groups) return null;
  const prefixMatches =
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0;
  if (!prefixMatches) return null;
  const a = (groups[6] >> 8) & 0xff;
  const b = groups[6] & 0xff;
  const c = (groups[7] >> 8) & 0xff;
  const d = groups[7] & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d) — validate the
  // embedded v4. This also catches the dotted NAT64 form `64:ff9b::a.b.c.d`.
  const embedded = lower.match(/(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) return isBlockedIPv4(embedded[1]);
  // NAT64 well-known prefix `64:ff9b::/96` in hex form (e.g.
  // `64:ff9b::a9fe:a9fe`): the low 32 bits are a synthesised IPv4, so decode
  // and re-check it as v4 — otherwise 64:ff9b::a9fe:a9fe (169.254.169.254)
  // would reach the cloud-metadata endpoint through a NAT64 gateway.
  const nat64 = nat64EmbeddedIPv4(lower);
  if (nat64) return isBlockedIPv4(nat64);
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

/** The parsed, validated target plus the exact resolved addresses cleared for it. */
export interface AllowedUrl {
  url: URL;
  /** Resolved IPs that all passed {@link isBlockedAddress}; the request is pinned to these. */
  addresses: string[];
}

/**
 * Validate a tenant-supplied URL for outbound fetching: http(s) only, and its
 * host must not resolve to any internal / loopback / link-local / metadata
 * address. Returns the parsed URL together with the resolved addresses that
 * passed the blocklist; {@link safeFetch} pins the connection to those exact
 * addresses. Throws {@link SsrfBlockedError} otherwise.
 *
 * DNS-rebinding TOCTOU is closed by design: the addresses returned here are the
 * ones the socket actually connects to (see {@link safeFetch}'s custom
 * `lookup`), so the name is never re-resolved between validation and connect.
 * The NAT64 well-known prefix is decoded in {@link isBlockedIPv6}, so a
 * synthesised metadata address can't slip past either.
 */
export async function assertUrlAllowed(rawUrl: string): Promise<AllowedUrl> {
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

  let resolved: LookupAddress[];
  try {
    resolved = await dnsLookup(host, { all: true, verbatim: true });
  } catch {
    throw new SsrfBlockedError(`The URL host "${host}" could not be resolved.`);
  }
  if (resolved.length === 0) throw new SsrfBlockedError(`The URL host "${host}" did not resolve to any address.`);
  const addresses: string[] = [];
  for (const { address } of resolved) {
    if (isBlockedAddress(address)) {
      throw new SsrfBlockedError(`The URL host "${host}" resolves to a blocked internal address.`);
    }
    addresses.push(address);
  }
  return { url, addresses };
}

/** Normalise the various `HeadersInit` shapes into a lower-cased header map. */
function toNodeHeaders(input?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  if (input instanceof Headers) {
    input.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
  } else if (Array.isArray(input)) {
    for (const [key, value] of input) out[key.toLowerCase()] = String(value);
  } else {
    for (const [key, value] of Object.entries(input)) out[key.toLowerCase()] = String(value);
  }
  return out;
}

function toBodyBuffer(body: BodyInit | null | undefined): Buffer | null {
  if (body == null) return null;
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  // Streams/Blobs/FormData aren't produced by any current caller; refuse
  // rather than silently coerce something lossy onto the wire.
  throw new SsrfBlockedError('Unsupported request body type for safeFetch (expected string, Buffer, or Uint8Array).');
}

interface RawResponse {
  status: number;
  statusText: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  location: string | null;
}

/**
 * Perform one request hop, connecting to `pinnedIp` regardless of what DNS
 * would say now. The original hostname is still used for the TLS SNI/servername
 * (so certificate validation is unchanged) and for the `Host` header.
 */
function pinnedRequest(url: URL, pinnedIp: string, init: RequestInit): Promise<RawResponse> {
  const isHttps = url.protocol === 'https:';
  const family = isIP(pinnedIp);
  const headers = toNodeHeaders(init.headers);
  if (headers.host === undefined) headers.host = url.host;

  const bodyBuffer = toBodyBuffer(init.body ?? undefined);
  if (bodyBuffer && headers['content-length'] === undefined && headers['transfer-encoding'] === undefined) {
    headers['content-length'] = String(bodyBuffer.length);
  }

  // A lookup that ignores the hostname and hands back the pre-validated IP,
  // so the socket connects to exactly what assertUrlAllowed cleared — no
  // second, unchecked DNS resolution (the DNS-rebinding TOCTOU window).
  const pinnedLookup: LookupFunction = ((
    _hostname: string,
    options: { all?: boolean },
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    if (options && options.all) callback(null, [{ address: pinnedIp, family }]);
    else callback(null, pinnedIp, family);
  }) as unknown as LookupFunction;

  const options: https.RequestOptions = {
    method: (init.method ?? 'GET').toUpperCase(),
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    headers,
    lookup: pinnedLookup,
    timeout: SOCKET_TIMEOUT_MS,
    ...(isHttps ? { servername: url.hostname } : {}),
  };

  return new Promise<RawResponse>((resolve, reject) => {
    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers: res.headers,
          body: Buffer.concat(chunks),
          location: (res.headers.location as string | undefined) ?? null,
        }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(SOCKET_TIMEOUT_MS, () => {
      req.destroy(new SsrfBlockedError(`The request to "${url.host}" timed out.`));
    });
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

/** Turn a buffered node response into a real global `Response`. */
function toResponse(raw: RawResponse): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.append(key, value);
  }
  // Copy into a plain Uint8Array view: node's `Buffer` isn't structurally a
  // `BodyInit`, but an `ArrayBufferView` is.
  const body = NULL_BODY_STATUSES.has(raw.status) ? null : new Uint8Array(raw.body);
  return new Response(body, {
    status: raw.status,
    statusText: raw.statusText,
    headers,
  });
}

/**
 * A drop-in `fetch` for tenant-supplied URLs. Validates the target (and every
 * redirect hop) against {@link assertUrlAllowed} before the request is made,
 * then connects to the exact IP that validation cleared — closing the
 * DNS-rebinding TOCTOU window that a plain resolve-then-fetch leaves open.
 * Redirects are followed manually so a same-origin-looking URL cannot be
 * server-side-redirected to an internal target; every hop is re-validated and
 * re-pinned. Throws {@link SsrfBlockedError} for a disallowed target and for
 * exceeding the redirect budget.
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}, maxRedirects = DEFAULT_MAX_REDIRECTS): Promise<Response> {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const { url, addresses } = await assertUrlAllowed(currentUrl);
    const raw = await pinnedRequest(url, addresses[0], init);
    const isRedirect = raw.status >= 300 && raw.status < 400 && raw.location;
    if (!isRedirect) return toResponse(raw);
    currentUrl = new URL(raw.location as string, url).toString();
  }
  throw new SsrfBlockedError(`The URL exceeded the maximum of ${maxRedirects} redirects.`);
}
