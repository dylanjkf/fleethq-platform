/**
 * Round 4 H3 — coverage for the post-login *obligations gate* and the staff-MFA
 * policy that drives it.
 *
 * This is a fully-mocked unit spec (no DB), so it runs in `jest` without the
 * Postgres the `*.e2e-spec.ts` suites need. It exercises the exact code path in
 * AdminPermissionGuard that returns `403 ADMIN_SETUP_REQUIRED`, plus
 * `staffAdminMfaEnforced()`. The DB-backed end-to-end assertion (a real seeded
 * admin flagged `mustResetPassword` being blocked from a permissioned route and
 * unblocked after clearing it) lives in the admin-auth e2e suite, which api-ci
 * runs against a real Postgres.
 */
import { AdminPermissionGuard } from './guards/admin-permission.guard';
import { staffAdminMfaEnforced } from './staff-admin-mfa-policy';
import * as adminRolePermissions from '../common/permissions/admin-role-has-permission';

type MockReflector = { getAllAndOverride: jest.Mock };

/** Build a guard with the four constructor deps mocked, plus handles to assert on. */
function makeGuard(opts: {
  required?: string;
  authenticatedOnly?: boolean;
  setupExempt?: boolean;
  dbUser: { mustResetPassword: boolean; mfaEnabledAt: Date | null } | null;
  roleId?: string;
  granted?: boolean;
}) {
  const reflector: MockReflector = {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === 'requiredAdminPermission') return opts.required;
      if (key === 'adminAuthenticatedOnly') return opts.authenticatedOnly ?? false;
      if (key === 'adminSetupExempt') return opts.setupExempt ?? false;
      return undefined;
    }),
  };
  const adminPrisma = {
    adminUser: {
      findUnique: jest.fn(async (args: { select?: Record<string, boolean> }) =>
        // obligations lookup selects mustResetPassword/mfaEnabledAt; the role lookup selects roleId
        args.select?.roleId ? { roleId: opts.roleId ?? 'role-1' } : opts.dbUser,
      ),
    },
  };
  const audit = { record: jest.fn(async () => undefined) };
  const logger = { warn: jest.fn(), error: jest.fn() };

  const guard = new AdminPermissionGuard(
    reflector as never,
    adminPrisma as never,
    audit as never,
    logger as never,
  );
  return { guard, reflector, adminPrisma, audit };
}

function ctx(userId = 'admin-1') {
  const request = { user: { adminUserId: userId }, url: '/admin/v1/orgs', method: 'GET', ip: '1.1.1.1', get: () => 'agent' };
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

describe('staffAdminMfaEnforced() — fail closed by default', () => {
  const originalFlag = process.env.ENFORCE_STAFF_ADMIN_MFA;
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.ENFORCE_STAFF_ADMIN_MFA;
    else process.env.ENFORCE_STAFF_ADMIN_MFA = originalFlag;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('is ON by default with no env var set (the regression guard — absence must NOT disable it)', () => {
    delete process.env.ENFORCE_STAFF_ADMIN_MFA;
    expect(staffAdminMfaEnforced()).toBe(true);
  });

  it('stays ON for anything other than an explicit false opt-out', () => {
    delete process.env.NODE_ENV; // non-production
    for (const v of ['true', 'TRUE', '', '1', 'yes', 'on', 'off']) {
      process.env.ENFORCE_STAFF_ADMIN_MFA = v;
      expect(staffAdminMfaEnforced()).toBe(true);
    }
  });

  it('honours an explicit false opt-out only OUTSIDE production', () => {
    process.env.NODE_ENV = 'development';
    for (const v of ['false', 'FALSE', 'False']) {
      process.env.ENFORCE_STAFF_ADMIN_MFA = v;
      expect(staffAdminMfaEnforced()).toBe(false);
    }
  });

  it('IGNORES the opt-out in production — staff MFA can never be turned off there', () => {
    process.env.NODE_ENV = 'production';
    process.env.ENFORCE_STAFF_ADMIN_MFA = 'false';
    expect(staffAdminMfaEnforced()).toBe(true);
  });
});

describe('AdminPermissionGuard — ADMIN_SETUP_REQUIRED obligations gate', () => {
  const original = process.env.ENFORCE_STAFF_ADMIN_MFA;
  afterEach(() => {
    if (original === undefined) delete process.env.ENFORCE_STAFF_ADMIN_MFA;
    else process.env.ENFORCE_STAFF_ADMIN_MFA = original;
  });

  it('blocks a pending-password-reset admin from a permissioned route and audits the denial', async () => {
    const { guard, audit } = makeGuard({
      required: 'required-admin-permission',
      dbUser: { mustResetPassword: true, mfaEnabledAt: new Date() },
      granted: true,
    });
    await expect(guard.canActivate(ctx())).rejects.toMatchObject({
      response: { code: 'ADMIN_SETUP_REQUIRED', obligations: { passwordReset: true, mfaEnrollment: false } },
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ reason: 'setup_required' }));
  });

  it('blocks an un-enrolled admin only when MFA enforcement is ON', async () => {
    process.env.ENFORCE_STAFF_ADMIN_MFA = 'true';
    const { guard } = makeGuard({
      required: 'required-admin-permission',
      dbUser: { mustResetPassword: false, mfaEnabledAt: null },
    });
    await expect(guard.canActivate(ctx())).rejects.toMatchObject({
      response: { code: 'ADMIN_SETUP_REQUIRED', obligations: { passwordReset: false, mfaEnrollment: true } },
    });
  });

  it('does NOT block an un-enrolled admin when MFA is explicitly opted out (non-prod)', async () => {
    process.env.ENFORCE_STAFF_ADMIN_MFA = 'false'; // deliberate non-prod opt-out
    const adminRoleHasPermission = jest
      .spyOn(adminRolePermissions, 'adminRoleHasPermission')
      .mockResolvedValue(true);
    const { guard } = makeGuard({
      required: 'required-admin-permission',
      dbUser: { mustResetPassword: false, mfaEnabledAt: null },
    });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    adminRoleHasPermission.mockRestore();
  });

  it('lets a @AdminSetupExempt route through even with pending obligations (so the admin can clear them)', async () => {
    const { guard } = makeGuard({
      authenticatedOnly: true,
      setupExempt: true,
      dbUser: { mustResetPassword: true, mfaEnabledAt: null },
    });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });
});
