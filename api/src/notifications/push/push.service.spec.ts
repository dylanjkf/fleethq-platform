import { createECDH, randomBytes } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import * as webpush from 'web-push';

/**
 * H1 (security audit): the push-delivery SSRF fix. These prove the two claims
 * the audit demanded evidence for:
 *   1. A subscription whose endpoint *hostname resolves* to a blocklisted
 *      address (e.g. the 169.254.169.254 cloud-metadata endpoint) is rejected
 *      at subscribe time — not just a literal internal IP, the DNS is resolved.
 *   2. Delivery goes out through safeFetch (pinned + re-validated), so a legit
 *      endpoint is delivered while a host that has rebound to an internal
 *      address is refused at send time rather than fetched.
 *
 * DNS is stubbed by mocking the `dns` module (safe-fetch resolves `dns.lookup`
 * at call time, so both subscribe-time validation and safeFetch see the stub),
 * so no real network I/O happens. safeFetch itself is the real implementation
 * by default (its pinning/blocklist is separately covered by safe-fetch.spec);
 * a couple of tests override just the socket write to assert delivery wiring.
 */

// A per-test resolver: host -> IP (or null for NXDOMAIN). `mock`-prefixed so
// jest lets the hoisted jest.mock factory reference it.
const mockDnsMap: { current: Record<string, string> } = { current: {} };

jest.mock('dns', () => {
  const actual = jest.requireActual('dns');
  return {
    ...actual,
    lookup: (host: string, options: unknown, cb?: unknown) => {
      const callback = (typeof options === 'function' ? options : cb) as (
        err: NodeJS.ErrnoException | null,
        addresses?: Array<{ address: string; family: number }>,
      ) => void;
      const address = mockDnsMap.current[host];
      if (!address) {
        const err = new Error(`ENOTFOUND ${host}`) as NodeJS.ErrnoException;
        err.code = 'ENOTFOUND';
        callback(err);
        return;
      }
      callback(null, [{ address, family: 4 }]);
    },
  };
});

jest.mock('../../common/net/safe-fetch', () => {
  const actual = jest.requireActual('../../common/net/safe-fetch');
  return {
    ...actual,
    // Default to the real safeFetch; individual tests can stub a single call
    // (mockImplementationOnce) to simulate a push-service HTTP response.
    safeFetch: jest.fn((...args: unknown[]) => (actual.safeFetch as (...a: unknown[]) => unknown)(...args)),
  };
});

import { safeFetch } from '../../common/net/safe-fetch';
import { PushService } from './push.service';

const safeFetchMock = safeFetch as jest.MockedFunction<typeof safeFetch>;

/** A real, valid Web Push subscription key pair (so generateRequestDetails works). */
function validKeys(): { p256dh: string; auth: string } {
  const ecdh = createECDH('prime256v1');
  return { p256dh: ecdh.generateKeys('base64url'), auth: randomBytes(16).toString('base64url') };
}

/** Stub DNS so `host` resolves to `address` (any other host: NXDOMAIN). */
function stubDns(map: Record<string, string>): void {
  mockDnsMap.current = map;
}

describe('PushService SSRF hardening (H1)', () => {
  const vapid = webpush.generateVAPIDKeys();
  let prisma: {
    pushSubscription: {
      upsert: jest.Mock;
      findMany: jest.Mock;
      delete: jest.Mock;
    };
  };
  let service: PushService;

  beforeEach(() => {
    prisma = {
      pushSubscription: {
        upsert: jest.fn().mockResolvedValue(undefined),
        findMany: jest.fn().mockResolvedValue([]),
        delete: jest.fn().mockResolvedValue(undefined),
      },
    };
    const config = {
      get: (key: string) =>
        ({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:test@fleethq.example' } as Record<
          string,
          string
        >)[key],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new PushService(prisma as any, config as any);
    safeFetchMock.mockClear();
  });

  afterEach(() => {
    mockDnsMap.current = {};
  });

  it('rejects a subscription whose hostname resolves to a blocklisted address', async () => {
    // A perfectly ordinary-looking public hostname that (per our stubbed DNS)
    // resolves to the cloud-metadata endpoint — the DNS-rebinding / internal
    // SSRF target. The old syntactic-only check would have accepted this.
    stubDns({ 'push.evil.example': '169.254.169.254' });

    await expect(
      service.subscribe('user-1', { endpoint: 'https://push.evil.example/wp/abc', keys: validKeys() }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_PUSH_ENDPOINT' } });
    await expect(
      service.subscribe('user-1', { endpoint: 'https://push.evil.example/wp/abc', keys: validKeys() }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Never persisted.
    expect(prisma.pushSubscription.upsert).not.toHaveBeenCalled();
  });

  it('rejects an RFC1918 / loopback hostname resolution too', async () => {
    stubDns({ 'metadata.corp.example': '10.1.2.3', 'lb.corp.example': '127.0.0.1' });
    await expect(
      service.subscribe('user-1', { endpoint: 'https://metadata.corp.example/x', keys: validKeys() }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.subscribe('user-1', { endpoint: 'https://lb.corp.example/x', keys: validKeys() }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.pushSubscription.upsert).not.toHaveBeenCalled();
  });

  it('accepts and stores a legitimate endpoint that resolves to a public address', async () => {
    stubDns({ 'fcm.googleapis.example': '93.184.216.34' });
    await expect(
      service.subscribe('user-1', { endpoint: 'https://fcm.googleapis.example/fcm/send/abc', keys: validKeys() }),
    ).resolves.toBeUndefined();
    expect(prisma.pushSubscription.upsert).toHaveBeenCalledTimes(1);
  });

  it('delivers a legitimate push through safeFetch with the encrypted VAPID request', async () => {
    stubDns({ 'fcm.googleapis.example': '93.184.216.34' });
    prisma.pushSubscription.findMany.mockResolvedValue([
      { id: 'sub-1', endpoint: 'https://fcm.googleapis.example/fcm/send/abc', ...validKeys() },
    ]);
    // Simulate the push service accepting the delivery.
    safeFetchMock.mockImplementationOnce(async () => new Response(null, { status: 201 }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).sendToUser('user-1', { title: 'Hi', body: 'test' });

    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = safeFetchMock.mock.calls[0];
    expect(url).toBe('https://fcm.googleapis.example/fcm/send/abc');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/vapid/i);
    expect(headers.TTL).toBeDefined();
    expect(init?.body).toBeInstanceOf(Uint8Array); // the encrypted payload
    expect(prisma.pushSubscription.delete).not.toHaveBeenCalled();
  });

  it('prunes a subscription the push service reports gone (410) instead of retrying', async () => {
    stubDns({ 'fcm.googleapis.example': '93.184.216.34' });
    prisma.pushSubscription.findMany.mockResolvedValue([
      { id: 'sub-gone', endpoint: 'https://fcm.googleapis.example/fcm/send/abc', ...validKeys() },
    ]);
    safeFetchMock.mockImplementationOnce(async () => new Response(null, { status: 410 }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).sendToUser('user-1', { title: 'Hi' });

    expect(prisma.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: 'sub-gone' } });
  });

  it('refuses to deliver to a stored endpoint that has rebound to an internal address', async () => {
    // A subscription that got past an earlier/weaker check (or a DNS rebind
    // after subscribe) now resolves internal. safeFetch (real, here) must block
    // it at send time — no request leaves the box, and the row is left intact
    // (not a 410) rather than delivered.
    stubDns({ 'rebound.evil.example': '169.254.169.254' });
    prisma.pushSubscription.findMany.mockResolvedValue([
      { id: 'sub-rebind', endpoint: 'https://rebound.evil.example/x', ...validKeys() },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    // Uses the real safeFetch (default mock impl) — it resolves DNS, sees the
    // blocked address, and throws SsrfBlockedError, which deliver() swallows.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((service as any).sendToUser('user-1', { title: 'Hi' })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Refusing push/));
    expect(prisma.pushSubscription.delete).not.toHaveBeenCalled();
  });
});
