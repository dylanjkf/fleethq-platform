import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WebauthnService } from './webauthn.service';

/**
 * Focused unit tests for the single-use-challenge fix (FIX 3). The
 * cryptographic verification is delegated to @simplewebauthn/server and not
 * exercised here — these tests cover only the challenge-consumption lifecycle:
 * a challenge JWT can be redeemed at most once, even while it's still within
 * its ~2-minute signed validity window, so a captured assertion can't be
 * replayed. No live DB is needed — the unique-constraint behaviour of the
 * `webauthn_challenge_consumptions` insert is simulated in-memory.
 */
describe('WebauthnService — single-use challenges', () => {
  const jwt = new JwtService({
    secret: 'test-secret',
    signOptions: { algorithm: 'HS256' },
    verifyOptions: { algorithms: ['HS256'] },
  });

  const makeService = () => {
    const consumed = new Set<string>();
    const create = jest.fn(async ({ data }: { data: { challengeHash: string } }) => {
      if (consumed.has(data.challengeHash)) {
        // Mirror Postgres' unique-violation surfaced by Prisma on a second insert.
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.22.0',
        });
      }
      consumed.add(data.challengeHash);
      return { id: 'consumption-1', ...data };
    });
    const findUnique = jest.fn(async () => null); // no stored credential — isolates the challenge path
    const systemPrisma = {
      webauthnChallengeConsumption: { create },
      webauthnCredential: { findUnique },
    } as unknown as import('../../prisma/system-prisma.service').SystemPrismaService;
    const config = { get: (_k: string, d?: unknown) => d } as unknown as import('@nestjs/config').ConfigService;
    const audit = { recordSystem: jest.fn() } as unknown as import('../../audit/audit.service').AuditService;
    const service = new WebauthnService(systemPrisma, jwt, config, audit);
    return { service, create };
  };

  const authToken = (challenge: string) => jwt.sign({ challenge, purpose: 'authenticate' }, { expiresIn: '2m' });

  it('rejects a second use of the same challenge (replay) even within its validity window', async () => {
    const { service, create } = makeService();
    const token = authToken('challenge-abc');

    // First use: challenge consumed, then no credential matches → null (a benign miss).
    await expect(service.verifyAuthentication(token, { id: 'cred-1' } as never)).resolves.toBeNull();
    expect(create).toHaveBeenCalledTimes(1);

    // Second use of the exact same (still-unexpired) challenge token → hard reject.
    await expect(service.verifyAuthentication(token, { id: 'cred-1' } as never)).rejects.toBeInstanceOf(UnauthorizedException);
    try {
      await service.verifyAuthentication(token, { id: 'cred-1' } as never);
      throw new Error('expected replay to be rejected');
    } catch (err) {
      expect((err as UnauthorizedException).getResponse()).toMatchObject({ code: 'CHALLENGE_ALREADY_USED' });
    }
  });

  it('allows a different, freshly-issued challenge (single-use is per-challenge, not global)', async () => {
    const { service } = makeService();
    await expect(service.verifyAuthentication(authToken('challenge-one'), { id: 'c' } as never)).resolves.toBeNull();
    await expect(service.verifyAuthentication(authToken('challenge-two'), { id: 'c' } as never)).resolves.toBeNull();
  });

  it('rejects a challenge token signed for the wrong purpose', async () => {
    const { service } = makeService();
    const registerToken = jwt.sign({ challenge: 'x', purpose: 'register', sub: 'u1' }, { expiresIn: '2m' });
    await expect(service.verifyAuthentication(registerToken, { id: 'c' } as never)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a garbage / unverifiable challenge token', async () => {
    const { service } = makeService();
    await expect(service.verifyAuthentication('not-a-real-jwt', { id: 'c' } as never)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
