/**
 * Round 4 — AdminMfaService.regenerateBackupCodes (mocked, no DB).
 * The DB-backed path is exercised by test/mfa.e2e-spec.ts in api-ci.
 */
import { BadRequestException } from '@nestjs/common';
import * as totp from '../../auth/mfa/totp';
import { AdminMfaService } from './admin-mfa.service';

function makeService(user: { mfaSecret: string | null; mfaEnabledAt: Date | null; mfaBackupCodes: string[] }) {
  const adminPrisma = {
    adminUser: {
      findUnique: jest.fn(async () => ({ id: 'a1', username: 'ops', ...user })),
      update: jest.fn(async (_args: { data: { mfaBackupCodes: string[] } }) => undefined),
    },
  };
  const audit = { record: jest.fn(async () => undefined) };
  const service = new AdminMfaService(adminPrisma as never, audit as never);
  return { service, adminPrisma, audit };
}

describe('AdminMfaService.regenerateBackupCodes', () => {
  afterEach(() => jest.restoreAllMocks());

  it('refuses when MFA is not enabled', async () => {
    const { service } = makeService({ mfaSecret: null, mfaEnabledAt: null, mfaBackupCodes: [] });
    await expect(service.regenerateBackupCodes('a1', '123456')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses on an incorrect current code (400 bad input, not a 401 session error)', async () => {
    jest.spyOn(totp, 'verifyTotp').mockReturnValue(false);
    const { service } = makeService({ mfaSecret: 'S', mfaEnabledAt: new Date(), mfaBackupCodes: [] });
    await expect(service.regenerateBackupCodes('a1', '000000')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('replaces the backup codes and audits on a valid current code', async () => {
    jest.spyOn(totp, 'verifyTotp').mockReturnValue(true);
    const { service, adminPrisma, audit } = makeService({ mfaSecret: 'S', mfaEnabledAt: new Date(), mfaBackupCodes: [] });
    const result = await service.regenerateBackupCodes('a1', '123456', {});
    expect(result.backupCodes).toHaveLength(10);
    // stored hashes, not the plaintext codes
    const updateArg = adminPrisma.adminUser.update.mock.calls[0][0];
    expect(updateArg.data.mfaBackupCodes).toHaveLength(10);
    expect(updateArg.data.mfaBackupCodes[0]).not.toBe(result.backupCodes[0]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin_auth.mfa_backup_codes_regenerated' }),
    );
  });
});
