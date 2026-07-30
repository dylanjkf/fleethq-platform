import { base32Decode, base32Encode, generateSecret, hotp, otpauthUrl, totp, verifyTotp } from './totp';

// RFC 4226 Appendix D uses the ASCII seed "12345678901234567890" (20 bytes).
const RFC_SECRET_ASCII = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET_BASE32 = base32Encode(RFC_SECRET_ASCII);

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 128, 64]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });
  it('encodes the RFC seed to the known base32 value', () => {
    expect(RFC_SECRET_BASE32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
});

describe('HOTP (RFC 4226 Appendix D test vectors)', () => {
  const EXPECTED = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  it.each(EXPECTED.map((v, i) => [i, v]))('counter %i -> %s', (counter, expected) => {
    expect(hotp(RFC_SECRET_ASCII, counter as number)).toBe(expected);
  });
});

describe('TOTP (RFC 6238 test vectors, SHA-1, 6-digit truncation)', () => {
  // RFC 6238 Appendix B values, truncated to 6 digits.
  const CASES: [number, string][] = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];
  it.each(CASES)('at unix %i -> %s', (unixSeconds, expected) => {
    expect(totp(RFC_SECRET_BASE32, unixSeconds * 1000)).toBe(expected);
  });
});

describe('verifyTotp', () => {
  const at = 59_000; // unix 59s
  it('accepts the correct current code', () => {
    expect(verifyTotp(RFC_SECRET_BASE32, '287082', at)).toBe(true);
  });
  it('accepts a code from the adjacent step (±30s clock skew)', () => {
    // The code valid at unix 59 is still accepted at unix 89 (next step) with window ±1.
    expect(verifyTotp(RFC_SECRET_BASE32, '287082', 89_000)).toBe(true);
  });
  it('rejects a code two steps away', () => {
    expect(verifyTotp(RFC_SECRET_BASE32, '287082', 130_000)).toBe(false);
  });
  it('rejects a malformed code', () => {
    expect(verifyTotp(RFC_SECRET_BASE32, 'abc', at)).toBe(false);
    expect(verifyTotp(RFC_SECRET_BASE32, '12345', at)).toBe(false);
  });
});

describe('generateSecret + otpauthUrl', () => {
  it('generates a decodable 160-bit secret', () => {
    const s = generateSecret();
    expect(base32Decode(s)).toHaveLength(20);
  });
  it('builds a valid otpauth URI a code can then be produced from', () => {
    const s = generateSecret();
    const url = otpauthUrl(s, 'alice@acme', 'FleetOS');
    expect(url).toMatch(/^otpauth:\/\/totp\/FleetOS:alice%40acme\?/);
    expect(url).toContain(`secret=${s}`);
    // A fresh secret produces a code its own verifier accepts.
    expect(verifyTotp(s, totp(s))).toBe(true);
  });
});
