import { JwtService } from '@nestjs/jwt';
import { AuthPolicyGateService } from './auth-policy-gate.service';

describe('AuthPolicyGateService', () => {
  const jwt = new JwtService({ secret: 'test-secret' });
  const gate = new AuthPolicyGateService(jwt);

  const membership = (mfaRequired: boolean, passwordExpiryDays: number | null = null) => ({
    id: 'membership-1',
    companyId: 'company-1',
    company: { securitySettings: { mfaRequired, passwordExpiryDays } },
  });

  it('lets a login through when the company has no security policy at all', () => {
    const noPolicyMembership = { id: 'm1', companyId: 'c1', company: { securitySettings: null } };
    const result = gate.checkPolicy({ id: 'u1', mfaEnabledAt: null, passwordChangedAt: new Date(), mustChangePassword: false }, noPolicyMembership, {});
    expect(result).toBeNull();
  });

  it('blocks with mfa_setup_required when MFA is mandated but not enabled', () => {
    const result = gate.checkPolicy({ id: 'u1', mfaEnabledAt: null, passwordChangedAt: new Date(), mustChangePassword: false }, membership(true), { loginMethod: 'password' });
    expect(result).toEqual({ status: 'mfa_setup_required', setupToken: expect.any(String) });
  });

  it('lets a login through when MFA is mandated and already enabled', () => {
    const result = gate.checkPolicy({ id: 'u1', mfaEnabledAt: new Date(), passwordChangedAt: new Date(), mustChangePassword: false }, membership(true), { loginMethod: 'password' });
    expect(result).toBeNull();
  });

  it('a verified WebAuthn/passkey login satisfies a mandatory-MFA policy on its own', () => {
    const result = gate.checkPolicy({ id: 'u1', mfaEnabledAt: null, passwordChangedAt: new Date(), mustChangePassword: false }, membership(true), { loginMethod: 'webauthn' });
    expect(result).toBeNull();
  });

  it('blocks with password_expired once the password has aged past the policy window', () => {
    const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const result = gate.checkPolicy({ id: 'u1', mfaEnabledAt: null, passwordChangedAt: staleDate, mustChangePassword: false }, membership(false, 30), {});
    expect(result).toEqual({ status: 'password_expired', changeToken: expect.any(String) });
  });

  it('forces a change (password_expired) for an admin-issued temporary credential, even with no expiry policy', () => {
    const result = gate.checkPolicy(
      { id: 'u1', mfaEnabledAt: null, passwordChangedAt: new Date(), mustChangePassword: true },
      membership(false),
      {},
    );
    expect(result).toEqual({ status: 'password_expired', changeToken: expect.any(String) });
  });

  it('still checks MFA before the must-change flag — a temp-credential account missing MFA sets up MFA first', () => {
    const result = gate.checkPolicy(
      { id: 'u1', mfaEnabledAt: null, passwordChangedAt: new Date(), mustChangePassword: true },
      membership(true),
      { loginMethod: 'password' },
    );
    expect(result).toEqual({ status: 'mfa_setup_required', setupToken: expect.any(String) });
  });

  it('lets a login through when the password is still within the expiry window', () => {
    const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const result = gate.checkPolicy({ id: 'u1', mfaEnabledAt: null, passwordChangedAt: recentDate, mustChangePassword: false }, membership(false, 30), {});
    expect(result).toBeNull();
  });

  it('checks MFA before password expiry — a login missing both gets mfa_setup_required first', () => {
    const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const result = gate.checkPolicy({ id: 'u1', mfaEnabledAt: null, passwordChangedAt: staleDate, mustChangePassword: false }, membership(true, 30), { loginMethod: 'password' });
    expect(result).toEqual({ status: 'mfa_setup_required', setupToken: expect.any(String) });
  });

  it('forces MFA for an admin-permission holder even when the company has no mandatory-MFA policy', () => {
    const result = gate.checkPolicy(
      { id: 'u1', mfaEnabledAt: null, passwordChangedAt: new Date(), mustChangePassword: false },
      membership(false),
      { loginMethod: 'password', holdsAdminPermission: true },
    );
    expect(result).toEqual({ status: 'mfa_setup_required', setupToken: expect.any(String) });
  });

  it('does not force MFA for a non-admin login when the company has no mandatory-MFA policy', () => {
    const result = gate.checkPolicy(
      { id: 'u1', mfaEnabledAt: null, passwordChangedAt: new Date(), mustChangePassword: false },
      membership(false),
      { loginMethod: 'password', holdsAdminPermission: false },
    );
    expect(result).toBeNull();
  });

  it('an admin-permission holder with MFA enabled (or a passkey login) is not blocked', () => {
    expect(
      gate.checkPolicy(
        { id: 'u1', mfaEnabledAt: new Date(), passwordChangedAt: new Date(), mustChangePassword: false },
        membership(false),
        { loginMethod: 'password', holdsAdminPermission: true },
      ),
    ).toBeNull();
    expect(
      gate.checkPolicy(
        { id: 'u1', mfaEnabledAt: null, passwordChangedAt: new Date(), mustChangePassword: false },
        membership(false),
        { loginMethod: 'webauthn', holdsAdminPermission: true },
      ),
    ).toBeNull();
  });

  it('verifyPolicyToken round-trips a minted token and rejects the wrong purpose', () => {
    const blocked = gate.checkPolicy({ id: 'u1', mfaEnabledAt: null, passwordChangedAt: new Date(), mustChangePassword: false }, membership(true), { loginMethod: 'password' }) as {
      status: 'mfa_setup_required';
      setupToken: string;
    };
    const payload = gate.verifyPolicyToken(blocked.setupToken, 'mfa_setup');
    expect(payload).toMatchObject({ sub: 'u1', membershipId: 'membership-1', companyId: 'company-1', purpose: 'mfa_setup' });
    expect(() => gate.verifyPolicyToken(blocked.setupToken, 'password_expired')).toThrow();
  });

  it('verifyPolicyToken rejects a garbage token', () => {
    expect(() => gate.verifyPolicyToken('not-a-real-token', 'mfa_setup')).toThrow();
  });
});
