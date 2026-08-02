import { assertUrlAllowed, isBlockedAddress, SsrfBlockedError } from './safe-fetch';

describe('isBlockedAddress', () => {
  it('blocks loopback, private, link-local, CGNAT, and metadata IPv4 ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata endpoint
      '169.254.0.1',
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '198.18.0.1', // benchmarking
      '224.0.0.1', // multicast
      '255.255.255.255', // broadcast
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it('allows ordinary public IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.10', '52.62.1.1']) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  it('blocks IPv6 loopback, unique-local, link-local, and IPv4-mapped private addresses', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it('blocks NAT64-synthesised internal/metadata addresses (well-known 64:ff9b::/96)', () => {
    for (const ip of [
      '64:ff9b::a9fe:a9fe', // hex form of 169.254.169.254 (cloud metadata)
      '64:ff9b::169.254.169.254', // dotted form of the same
      '64:ff9b::7f00:1', // 127.0.0.1 loopback
      '64:ff9b::10.0.0.1', // 10.0.0.1 private
      '64:ff9b:0:0:0:0:a9fe:a9fe', // fully-expanded hex form
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it('allows a NAT64 address whose embedded IPv4 is public', () => {
    expect(isBlockedAddress('64:ff9b::808:808')).toBe(false); // 8.8.8.8
    expect(isBlockedAddress('64:ff9b::8.8.8.8')).toBe(false);
  });

  it('allows a public IPv6 address', () => {
    expect(isBlockedAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('refuses a non-IP string', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
  });
});

describe('assertUrlAllowed', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertUrlAllowed('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertUrlAllowed('ftp://example.com')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('rejects a URL whose host is a literal internal/metadata IP', async () => {
    await expect(assertUrlAllowed('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertUrlAllowed('http://127.0.0.1:5432/')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertUrlAllowed('http://[::1]/')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertUrlAllowed('http://10.0.0.1/internal')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('rejects a malformed URL', async () => {
    await expect(assertUrlAllowed('http://')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertUrlAllowed('not a url')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('allows a public literal IP (resolves without external DNS, so hermetic) and pins its address', async () => {
    const result = await assertUrlAllowed('https://8.8.8.8/webhook');
    expect(result.url).toBeInstanceOf(URL);
    expect(result.url.href).toBe('https://8.8.8.8/webhook');
    // The validated address is returned so safeFetch can pin the connection to it.
    expect(result.addresses).toContain('8.8.8.8');
  });
});
