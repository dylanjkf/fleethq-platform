import { Injectable } from '@nestjs/common';
import { AdminAuthTokenType } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { AdminPrismaService } from '../prisma/admin-prisma.service';

const TTL_MS: Record<AdminAuthTokenType, number> = {
  PASSWORD_RESET: 60 * 60 * 1000, // an hour for a reset link, matching the customer PASSWORD_RESET TTL
};

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Issues and redeems the single-use tokens behind the admin console's
 * self-service password-reset link — the admin-scoped mirror of
 * `AuthTokensService`. Runs on the BYPASSRLS `fleetos_admin` role (its own
 * `admin_*` table space). Only the token's SHA-256 hash is stored, so the DB
 * never holds anything replayable; the raw token exists only in the emailed
 * link.
 */
@Injectable()
export class AdminAuthTokensService {
  constructor(private readonly adminPrisma: AdminPrismaService) {}

  /** Creates a token, returning the raw value to embed in a link (never stored). */
  async issue(adminUserId: string, type: AdminAuthTokenType): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    await this.adminPrisma.adminAuthToken.create({
      data: { adminUserId, type, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + TTL_MS[type]) },
    });
    return raw;
  }

  /**
   * Redeems a token: returns the adminUserId if it's a valid, unexpired,
   * unused token of the given type (marking it used), or null otherwise.
   * Idempotent against replay — a second redemption of the same token finds it
   * used.
   */
  async consume(raw: string, type: AdminAuthTokenType): Promise<string | null> {
    const tokenHash = hashToken(raw);
    const token = await this.adminPrisma.adminAuthToken.findFirst({
      where: { tokenHash, type, usedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!token) return null;
    await this.adminPrisma.adminAuthToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
    return token.adminUserId;
  }

  /** Invalidates any outstanding tokens of a type for an admin (e.g. after a reset). */
  async invalidateAll(adminUserId: string, type: AdminAuthTokenType): Promise<void> {
    await this.adminPrisma.adminAuthToken.updateMany({
      where: { adminUserId, type, usedAt: null },
      data: { usedAt: new Date() },
    });
  }
}
