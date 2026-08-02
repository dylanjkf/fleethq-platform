import * as bcrypt from 'bcrypt';
import { UnauthorizedException } from '@nestjs/common';
import { OAuthProvider } from '@prisma/client';
import { AuthService } from './auth.service';

/**
 * Focused unit tests for the two account-security notification/step-up fixes
 * that live in AuthService:
 *  - FIX 2: the FIRST-time auto-link of a verified social identity to an
 *    existing account must alert + audit the owner (and must NOT fire on a
 *    subsequent login by an already-linked identity).
 *  - FIX 1: enrolling a passkey requires step-up re-auth (current password or
 *    a live MFA code); without it the registration is rejected before any
 *    credential is stored.
 *
 * No live DB — every collaborator is a jest mock. The login-completion tail
 * (memberships → session token) is mocked to a single-company success so the
 * OAuth tests can assert the notification side-effects on a fully successful
 * login.
 */
describe('AuthService — account-security fixes', () => {
  const membership = { id: 'm1', companyId: 'c1', company: { id: 'c1', name: 'Acme Fleet', securitySettings: null } };

  const baseUser = {
    id: 'u1',
    username: 'user1',
    fullName: 'User One',
    email: 'user1@example.com',
    mfaEnabledAt: null as Date | null,
    tokenVersion: 0,
    passwordChangedAt: new Date(),
    archivedAt: null as Date | null,
    passwordHash: bcrypt.hashSync('Correct-Password1', 4),
    mfaSecret: null as string | null,
    mfaBackupCodes: [] as string[],
  };

  const build = () => {
    const txMock = { companyMembership: { findMany: jest.fn(async () => [membership]) } };
    const prisma = {
      withUser: jest.fn((_uid: string, cb: (tx: unknown) => unknown) => cb(txMock)),
      withTenant: jest.fn(),
    };
    const systemPrisma = {
      user: {
        findUnique: jest.fn(async () => ({ ...baseUser })),
        findUniqueOrThrow: jest.fn(async () => ({ ...baseUser })),
        findMany: jest.fn(async () => [{ ...baseUser }]),
      },
      oAuthIdentity: {
        findUnique: jest.fn(async (): Promise<{ id: string; userId: string } | null> => null),
        create: jest.fn(async () => ({ id: 'oid-1' })),
        update: jest.fn(async () => ({})),
      },
    };
    const jwt = { sign: jest.fn(() => 'signed'), verify: jest.fn() };
    const mail = {
      sendOAuthLinked: jest.fn(async () => undefined),
      sendPasskeyAdded: jest.fn(async () => undefined),
      sendNewDeviceLogin: jest.fn(async () => undefined),
    };
    const sessions = {
      isDeviceTrusted: jest.fn(async () => false),
      hasKnownIpUserAgent: jest.fn(async () => true), // suppress the new-device alert in these tests
      issueSessionToken: jest.fn(async () => 'access-token'),
      revokeOtherSessions: jest.fn(async () => undefined),
    };
    const audit = { recordSystem: jest.fn(async () => undefined) };
    const policyGate = { checkPolicy: jest.fn(() => null) };
    const mfa = { verifyChallenge: jest.fn(async () => ({ ok: false, usedBackupCode: false })) };
    const oidc = { verify: jest.fn() };
    const webauthn = { verifyRegistration: jest.fn(async () => undefined) };

    const service = new AuthService(
      prisma as never,
      systemPrisma as never,
      jwt as never,
      {} as never, // authTokens
      mail as never,
      sessions as never,
      {} as never, // recovery
      {} as never, // passwordPolicy
      policyGate as never,
      audit as never,
      mfa as never,
      oidc as never,
      webauthn as never,
      { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    );
    return { service, systemPrisma, mail, sessions, audit, oidc, webauthn, mfa };
  };

  describe('loginWithOAuth — first-time link notification (FIX 2)', () => {
    it('alerts + audits the owner the first time a verified identity auto-links to an existing account', async () => {
      const { service, systemPrisma, mail, audit, oidc } = build();
      systemPrisma.oAuthIdentity.findUnique.mockResolvedValue(null); // not previously linked
      oidc.verify.mockResolvedValue({ emailVerified: true, email: 'user1@example.com', subject: 'google-sub-123' });

      const result = await service.loginWithOAuth(OAuthProvider.GOOGLE, 'id-token', undefined, false, { ip: '1.2.3.4' });

      expect(result).toMatchObject({ status: 'authenticated' });
      expect(systemPrisma.oAuthIdentity.create).toHaveBeenCalledTimes(1);
      expect(mail.sendOAuthLinked).toHaveBeenCalledTimes(1);
      expect(mail.sendOAuthLinked).toHaveBeenCalledWith('user1@example.com', 'User One', 'Google', expect.any(Date));
      expect(audit.recordSystem).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.oauth_identity_linked' }));
    });

    it('does NOT re-notify on a later login by an already-linked identity', async () => {
      const { service, systemPrisma, mail, audit, oidc } = build();
      systemPrisma.oAuthIdentity.findUnique.mockResolvedValue({ id: 'oid-1', userId: 'u1' }); // already linked
      oidc.verify.mockResolvedValue({ emailVerified: true, email: 'user1@example.com', subject: 'google-sub-123' });

      const result = await service.loginWithOAuth(OAuthProvider.GOOGLE, 'id-token', undefined, false, {});

      expect(result).toMatchObject({ status: 'authenticated' });
      expect(systemPrisma.oAuthIdentity.create).not.toHaveBeenCalled();
      expect(mail.sendOAuthLinked).not.toHaveBeenCalled();
      expect(audit.recordSystem).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.oauth_identity_linked' }));
    });
  });

  describe('completeWebauthnRegistration — step-up re-auth (FIX 1)', () => {
    it('rejects registration when no re-auth proof is supplied, before storing any credential', async () => {
      const { service, webauthn, sessions, mail } = build();
      await expect(
        service.completeWebauthnRegistration('u1', 'session-1', 'challenge-token', {} as never, {}),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(webauthn.verifyRegistration).not.toHaveBeenCalled();
      expect(sessions.revokeOtherSessions).not.toHaveBeenCalled();
      expect(mail.sendPasskeyAdded).not.toHaveBeenCalled();
    });

    it('rejects registration when the supplied current password is wrong', async () => {
      const { service, webauthn } = build();
      await expect(
        service.completeWebauthnRegistration('u1', 'session-1', 'challenge-token', {} as never, { currentPassword: 'wrong' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(webauthn.verifyRegistration).not.toHaveBeenCalled();
    });

    it('stores the credential, revokes other sessions, and emails the owner on valid password re-auth', async () => {
      const { service, webauthn, sessions, mail } = build();
      await service.completeWebauthnRegistration(
        'u1',
        'session-1',
        'challenge-token',
        {} as never,
        { currentPassword: 'Correct-Password1' },
        'My Laptop',
        { ip: '9.9.9.9' },
      );
      expect(webauthn.verifyRegistration).toHaveBeenCalledWith(
        'u1',
        'challenge-token',
        {},
        'My Laptop',
        expect.objectContaining({ actorLabel: 'user1', ip: '9.9.9.9' }),
      );
      expect(sessions.revokeOtherSessions).toHaveBeenCalledWith('u1', 'session-1');
      expect(mail.sendPasskeyAdded).toHaveBeenCalledWith('user1@example.com', 'User One', 'My Laptop');
    });

    it('accepts a valid MFA code as step-up when the account has MFA enabled', async () => {
      const { service, systemPrisma, mfa, webauthn } = build();
      systemPrisma.user.findUniqueOrThrow.mockResolvedValue({ ...baseUser, mfaEnabledAt: new Date(), mfaSecret: 'SECRET' });
      mfa.verifyChallenge.mockResolvedValue({ ok: true, usedBackupCode: false });
      await service.completeWebauthnRegistration('u1', 'session-1', 'challenge-token', {} as never, { mfaCode: '123456' });
      expect(mfa.verifyChallenge).toHaveBeenCalled();
      expect(webauthn.verifyRegistration).toHaveBeenCalled();
    });
  });
});
