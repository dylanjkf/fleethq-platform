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
import { ForbiddenException } from '@nestjs/common';
import { AdminPermissionGuard } from './guards/admin-permission.guard';
import { staffAdminMfaEnforced } from './staff-admin-mfa-policy';

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

describe('staffAdminMfaEnforced()', () => {
  const original = process.env.ENFORCE_STAFF_ADMIN_MFA;
  afterEach(() => {
    if (original === undefined) delete process.env.ENFORCE_STAFF_ADMIN_MFA;
    else process.env.ENFORCE_STAFF_ADMIN_MFA = original;
  });

  it('is OFF by default (unset)', () => {
    delete process.env.ENFORCE_STAFF_ADMIN_MFA;
    expect(staffAdminMfaEnforced()).toBe(false);
  });

  it('is OFF for any value other than an explicit true', () => {
    for (const v of ['false', 'FALSE', '', '1', 'yes', 'on']) {
      process.env.ENFORCE_STAFF_ADMIN_MFA = v;
      expect(staffAdminMfaEnforced()).toBe(false);
    }
  });

  it('is ON only for an explicit truthy opt-in (case-insensitive)', () => {
    for (const v of ['true', 'TRUE', 'True']) {
      process.env.ENFORCE_STAFF_ADMIN_MFA = v;
      expect(staffAdminMfaEnforced()).toBe(true);
    }
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

  it('does NOT block an un-enrolled admin when MFA is optional (default OFF)', async () => {
    delete process.env.ENFORCE_STAFF_ADMIN_MFA;
    const adminRoleHasPermission = jest
      .spyOn(require('../common/permissions/admin-role-has-permission'), 'adminRoleHasPermission')
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
