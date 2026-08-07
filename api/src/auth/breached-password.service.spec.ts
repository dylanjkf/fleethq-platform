import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';

// safeFetch is the only outbound; mock it so no real HIBP call happens.
jest.mock('../common/net/safe-fetch', () => ({
  safeFetch: jest.fn(),
}));

import { safeFetch } from '../common/net/safe-fetch';
import { BreachedPasswordService } from './breached-password.service';

const safeFetchMock = safeFetch as jest.MockedFunction<typeof safeFetch>;

/** Build a HIBP range-API body whose suffix line matches `password` with `count` hits. */
function hibpBodyFor(password: string, count: number, padding = ['0000000000000000000000000000000000000:0']): string {
  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const suffix = sha1.slice(5);
  return [`${suffix}:${count}`, ...padding].join('\r\n');
}

describe('BreachedPasswordService (M1)', () => {
  let service: BreachedPasswordService;

  beforeEach(() => {
    service = new BreachedPasswordService();
    safeFetchMock.mockReset();
  });

  it('rejects a password that appears in the HIBP corpus', async () => {
    // Fresh Response per call — a body can only be read once.
    safeFetchMock.mockImplementation(async () => new Response(hibpBodyFor('Password1!', 4567), { status: 200 }));
    await expect(service.assertNotBreached('Password1!')).rejects.toMatchObject({
      response: { code: 'PASSWORD_BREACHED' },
    });
    await expect(service.assertNotBreached('Password1!')).rejects.toBeInstanceOf(BadRequestException);
    // Only the SHA-1 prefix (5 hex chars) is ever sent — k-anonymity.
    const [url] = safeFetchMock.mock.calls[0];
    expect(url).toMatch(/\/range\/[0-9A-F]{5}$/);
    expect(url).not.toContain('Password1!');
  });

  it('treats a padded count of 0 as not-breached', async () => {
    // HIBP's Add-Padding returns decoy suffixes with count 0 — must not match.
    safeFetchMock.mockResolvedValue(new Response(hibpBodyFor('Zx9$rare-Passphrase', 0), { status: 200 }));
    await expect(service.assertNotBreached('Zx9$rare-Passphrase')).resolves.toBeUndefined();
  });

  it('accepts a password whose suffix is absent from the range', async () => {
    safeFetchMock.mockResolvedValue(
      new Response('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:2\r\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:9', { status: 200 }),
    );
    await expect(service.assertNotBreached('a-Very-Unique-One-2026')).resolves.toBeUndefined();
  });

  it('fails open (allows) when the HIBP API errors', async () => {
    safeFetchMock.mockResolvedValue(new Response('bad gateway', { status: 502 }));
    await expect(service.assertNotBreached('Password1!')).resolves.toBeUndefined();
  });

  it('fails open (allows) when the HIBP API is unreachable', async () => {
    safeFetchMock.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(service.assertNotBreached('Password1!')).resolves.toBeUndefined();
  });
});
