import { Injectable } from '@nestjs/common';
import { AuthTokenType } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { SystemPrismaService } from '../prisma/system-prisma.service';

const TTL_MS: Record<AuthTokenType, number> = {
  EMAIL_VERIFY: 24 * 60 * 60 * 1000, // a day to click a verification link
  PASSWORD_RESET: 60 * 60 * 1000, // an hour for a reset/invite link
  MAGIC_LINK: 15 * 60 * 1000, // a live login attempt, not a link to open later
};

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Issues and redeems the single-use tokens behind email verification, password
 * reset, and invite links. Runs on the BYPASSRLS `fleetos_auth` role because
 * these flows have no tenant context. Only the token's SHA-256 hash is stored,
 * so the DB never holds anything replayable; the raw token exists only in the
 * emailed link.
 */
@Injectable()
export class AuthTokensService {
  constructor(private readonly systemPrisma: SystemPrismaService) {}

  /** Creates a token, returning the raw value to embed in a link (never stored). */
  async issue(userId: string, type: AuthTokenType): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    await this.systemPrisma.authToken.create({
      data: { userId, type, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + TTL_MS[type]) },
    });
    return raw;
  }

  /**
   * Redeems a token: returns the userId if it's a valid, unexpired, unused
   * token of the given type (marking it used), or null otherwise. Idempotent
   * against replay — a second redemption of the same token finds it used.
   */
  async consume(raw: string, type: AuthTokenType): Promise<string | null> {
    const tokenHash = hashToken(raw);
    const token = await this.systemPrisma.authToken.findFirst({
      where: { tokenHash, type, usedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!token) return null;
    await this.systemPrisma.authToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
    return token.userId;
  }

  /** Invalidates any outstanding tokens of a type for a user (e.g. after a reset). */
  async invalidateAll(userId: string, type: AuthTokenType): Promise<void> {
    await this.systemPrisma.authToken.updateMany({
      where: { userId, type, usedAt: null },
      data: { usedAt: new Date() },
    });
  }
}
