import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AdminPrismaService } from '../../prisma/admin-prisma.service';
import { AdminJwtPayload, AuthenticatedAdminRequestUser } from '../admin-jwt-payload.interface';

/**
 * Registered under the Passport strategy name `admin-jwt` (see the second
 * constructor arg to `PassportStrategy`) — a distinct name from the
 * customer-facing `jwt` strategy, so `AdminJwtAuthGuard`'s
 * `AuthGuard('admin-jwt')` can never accidentally accept a customer session
 * token, and vice versa, even if both guards were mistakenly applied to the
 * same route (which they never are — see the isolation notes on
 * AdminPrismaService and the /admin/v1 route prefix).
 */
@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(
    config: ConfigService,
    private readonly adminPrisma: AdminPrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('ADMIN_JWT_SECRET'),
      algorithms: ['HS256'],
    });
  }

  /**
   * Beyond signature/expiry, confirms: the admin account still exists and
   * isn't disabled, the token's `tv` matches the account's current
   * tokenVersion (a password reset/rotation revokes every existing session
   * at once), and the specific AdminSession this token names hasn't been
   * revoked or expired — the last check is what makes per-device "session
   * revocation" actually work, independent of the JWT's own signed exp.
   */
  async validate(payload: AdminJwtPayload): Promise<AuthenticatedAdminRequestUser> {
    const invalid = () =>
      new UnauthorizedException({ code: 'ADMIN_TOKEN_REVOKED', message: 'This admin session is no longer valid. Please sign in again.' });

    const user = await this.adminPrisma.adminUser.findUnique({
      where: { id: payload.sub },
      select: { tokenVersion: true, archivedAt: true },
    });
    if (!user || user.archivedAt || user.tokenVersion !== payload.tv) throw invalid();

    const session = await this.adminPrisma.adminSession.findUnique({ where: { id: payload.sid } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) throw invalid();

    // Best-effort liveness ping for "last seen" — not awaited on the critical
    // path so a slow write never adds latency to every authenticated request.
    void this.adminPrisma.adminSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);

    return { adminUserId: payload.sub, sessionId: payload.sid };
  }
}
