import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { SystemPrismaService } from '../../prisma/system-prisma.service';
import { AuthenticatedRequestUser, JwtPayload } from '../jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly systemPrisma: SystemPrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET'),
      // Pin the accepted signature algorithm. Tokens are signed HS256
      // (symmetric, see AuthTokensService); allowing only HS256 on verify
      // forecloses algorithm-substitution attacks (e.g. an attacker-supplied
      // "alg":"none" token, or an RS256 token verified with the public key as
      // an HMAC secret) rather than accepting whatever the token header claims.
      algorithms: ['HS256'],
    });
  }

  /**
   * Return value becomes `req.user`. Beyond signature/expiry (handled by the
   * strategy), we confirm the token hasn't been revoked: it carries the user's
   * `tokenVersion` at issue time, and a password reset bumps that version — so
   * a session minted before the reset is rejected here even though its 12h
   * signature is still valid. A single indexed PK lookup by user id, via the
   * pre-tenant-context auth role (no company context exists at this layer yet).
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedRequestUser> {
    const user = await this.systemPrisma.user.findUnique({
      where: { id: payload.sub },
      select: { tokenVersion: true, archivedAt: true },
    });
    if (!user || user.archivedAt || user.tokenVersion !== payload.tv) {
      throw new UnauthorizedException({ code: 'TOKEN_REVOKED', message: 'This session is no longer valid. Please sign in again.' });
    }
    return {
      userId: payload.sub,
      companyId: payload.companyId,
      membershipId: payload.membershipId,
    };
  }
}
