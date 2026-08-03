import { BadRequestException, ConflictException, HttpStatus, ParseUUIDPipe } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminUsersService } from './admin-users.service';

/**
 * Unit coverage for the staff-account management surface (FIX 8). Deps are
 * mocked, so these run headless — the full HTTP path (guards + real DB) is the
 * job of an e2e spec, noted in the task report as DB-dependent.
 */
describe('AdminUsersService', () => {
  const context = { adminUserId: 'admin-1', ip: '127.0.0.1', userAgent: 'jest' };

  function build(overrides: Record<string, unknown> = {}) {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const adminPrisma = {
      adminUser: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      adminRole: { findUnique: jest.fn().mockResolvedValue({ id: 'role-1', name: 'Support' }) },
      adminSession: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
      ...overrides,
    };
    const service = new AdminUsersService(adminPrisma as never, audit as never);
    return { service, adminPrisma, audit };
  }

  it('creates a staff account, hashes the password, and never returns the hash', async () => {
    const { service, adminPrisma, audit } = build();
    (adminPrisma.adminUser.create as jest.Mock).mockResolvedValue({
      id: 'new-1',
      username: 'sam',
      email: 'sam@fleethq.test',
      fullName: 'Sam',
      roleId: 'role-1',
      role: { id: 'role-1', name: 'Support' },
      mfaEnabledAt: null,
      lockedUntil: null,
      mustResetPassword: false,
      archivedAt: null,
      createdAt: new Date(),
    });

    const result = await service.create(
      { username: 'sam', email: 'sam@fleethq.test', fullName: 'Sam', password: 'correcthorse9', roleId: 'role-1' },
      context,
    );

    const createArg = (adminPrisma.adminUser.create as jest.Mock).mock.calls[0][0];
    expect(createArg.data.passwordHash).toBeDefined();
    expect(createArg.data.passwordHash).not.toBe('correcthorse9');
    // Onboarded staff must rotate the temporary password on first login.
    expect(createArg.data.mustResetPassword).toBe(true);
    expect(result).not.toHaveProperty('passwordHash');
    expect(result.deactivated).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin_users.created' }));
  });

  it('maps a unique-constraint violation to a 409 conflict', async () => {
    const { service, adminPrisma } = build();
    (adminPrisma.adminUser.create as jest.Mock).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '5', meta: { target: ['username'] } }),
    );
    await expect(
      service.create({ username: 'sam', email: 'sam@fleethq.test', fullName: 'Sam', password: 'correcthorse9', roleId: 'role-1' }, context),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to deactivate your own account', async () => {
    const { service } = build();
    await expect(service.deactivate('admin-1', context)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deactivating another admin revokes their sessions and bumps tokenVersion', async () => {
    const { service, adminPrisma, audit } = build();
    (adminPrisma.adminUser.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: 'admin-2', username: 'lee', archivedAt: null, role: { id: 'role-1', name: 'Support' } }) // requireAdminUser
      .mockResolvedValue({ // getById at the end
        id: 'admin-2', username: 'lee', email: 'lee@x', fullName: 'Lee', roleId: 'role-1',
        role: { id: 'role-1', name: 'Support' }, mfaEnabledAt: null, lockedUntil: null,
        mustResetPassword: false, archivedAt: new Date(), createdAt: new Date(),
      });

    await service.deactivate('admin-2', context);

    const updateArg = (adminPrisma.adminUser.update as jest.Mock).mock.calls[0][0];
    expect(updateArg.data.archivedAt).toBeInstanceOf(Date);
    expect(updateArg.data.tokenVersion).toEqual({ increment: 1 });
    expect(adminPrisma.adminSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { adminUserId: 'admin-2', revokedAt: null } }),
    );
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin_users.deactivated' }));
  });
});

/**
 * FIX 1: admin routes attach ParseUUIDPipe to their UUID params, so a
 * malformed id is rejected as a clean 400 before reaching the service. The
 * pipe is Nest's own, exercised directly here (headless) to lock in the 400
 * contract the routes rely on.
 */
describe('ParseUUIDPipe on admin :id params', () => {
  const pipe = new ParseUUIDPipe();
  const meta = { type: 'param' as const, metatype: String, data: 'id' };

  it('rejects a malformed UUID with a 400', async () => {
    await expect(pipe.transform('not-a-uuid', meta)).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('passes a well-formed UUID through unchanged', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    await expect(pipe.transform(id, meta)).resolves.toBe(id);
  });
});
