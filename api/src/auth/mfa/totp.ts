import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Dependency-free TOTP (RFC 6238) over HOTP (RFC 4226), SHA-1, 6 digits, 30s
 * step — the algorithm every authenticator app (Google Authenticator, Authy,
 * 1Password, …) speaks. Kept dependency-free on purpose: the surface is small,
 * the algorithm is fixed by the RFCs, and it's exercised against the published
 * RFC test vectors in totp.spec.ts, so a hand-rolled implementation is both
 * auditable and one fewer third-party dependency in the auth path.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648

/** Encode raw bytes as unpadded RFC 4648 base32 (the format authenticator apps expect). */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decode an RFC 4648 base32 string (case-insensitive, spaces/padding ignored). */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) for a given counter — the building block of TOTP. */
export function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter (JS numbers are safe well past any realistic step).
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/** The current TOTP for a base32 secret at a given time (defaults to now). */
export function totp(secretBase32: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  return hotp(base32Decode(secretBase32), counter);
}

/**
 * Verify a submitted 6-digit code against the secret, allowing ±`window` steps
 * of clock skew (default ±1 = ±30s). Constant-time comparison per candidate so
 * a timing side-channel can't distinguish a near-miss.
 */
export function verifyTotp(secretBase32: string, token: string, atMs: number = Date.now(), window = 1): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  const submitted = Buffer.from(token);
  for (let error = -window; error <= window; error += 1) {
    const candidate = Buffer.from(hotp(secret, counter + error));
    if (candidate.length === submitted.length && timingSafeEqual(candidate, submitted)) return true;
  }
  return false;
}

/** A fresh 160-bit base32 secret (RFC 4226 recommends ≥ 128 bits; 160 matches SHA-1). */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * The otpauth:// provisioning URI an authenticator app imports (usually via QR).
 * Label and issuer are URL-encoded; issuer appears both in the path and as a
 * parameter, per the Key URI Format spec.
 */
export function otpauthUrl(secretBase32: string, accountName: string, issuer = 'FleetOS'): string {
  // Per the Key URI Format, the label is `issuer:account` with the colon as a
  // literal separator — encode the two parts, not the separator itself.
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
