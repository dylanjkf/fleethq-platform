import { Prisma } from '@prisma/client';
import { HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService, isSerializationFailure } from './prisma.service';

/**
 * Unit coverage for the serialization-failure retry helper added for the plan
 * usage-limit TOCTOU fix (audit remediation: billing). The end-to-end race
 * itself needs a real Postgres at SERIALIZABLE isolation to reproduce (two
 * concurrent creates at the cap), so that is left to an integration/e2e run;
 * here we prove the pure retry/classification logic without a DB by driving the
 * method against a stubbed `withTenant`.
 */
describe('isSerializationFailure', () => {
  it('is true for Prisma P2034 (write conflict / deadlock, wraps SQLSTATE 40001/40P01)', () => {
    const err = new Prisma.PrismaClientKnownRequestError('write conflict', { code: 'P2034', clientVersion: 'test' });
    expect(isSerializationFailure(err)).toBe(true);
  });

  it('is false for an unrelated Prisma error code (e.g. P2002 unique violation)', () => {
    const err = new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
    expect(isSerializationFailure(err)).toBe(false);
  });

  it('matches a raw SQLSTATE 40001 surfaced as an unknown request error', () => {
    const err = new Prisma.PrismaClientUnknownRequestError('could not serialize access (SQLSTATE 40001)', { clientVersion: 'test' });
    expect(isSerializationFailure(err)).toBe(true);
  });

  it('is false for an ordinary Error', () => {
    expect(isSerializationFailure(new Error('nope'))).toBe(false);
  });
});

describe('PrismaService.withTenantSerializable', () => {
  // Build a bare instance without constructing the real PrismaClient (no DB).
  // Typed loosely because `logger`/`withTenant` are private/instance members;
  // we only need to drive `withTenantSerializable`'s retry loop here.
  interface TestSvc {
    logger: { debug: jest.Mock };
    withTenant: jest.Mock;
    withTenantSerializable: PrismaService['withTenantSerializable'];
  }
  function build(): TestSvc {
    const svc = Object.create(PrismaService.prototype) as TestSvc;
    svc.logger = { debug: jest.fn() };
    svc.withTenant = jest.fn();
    return svc;
  }

  const serializationError = () => new Prisma.PrismaClientKnownRequestError('write conflict', { code: 'P2034', clientVersion: 'test' });

  it('runs at SERIALIZABLE isolation', async () => {
    const svc = build();
    svc.withTenant.mockResolvedValue('ok');
    await svc.withTenantSerializable('company-1', async () => 'ok');
    expect(svc.withTenant).toHaveBeenCalledWith(
      'company-1',
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  });

  it('retries on a serialization failure and then succeeds', async () => {
    const svc = build();
    svc.withTenant.mockRejectedValueOnce(serializationError()).mockResolvedValueOnce('ok');
    await expect(svc.withTenantSerializable('company-1', async () => 'ok')).resolves.toBe('ok');
    expect(svc.withTenant).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a non-serialization error (e.g. a 402 plan-limit rejection propagates immediately)', async () => {
    const svc = build();
    const limitError = new HttpException({ code: 'PLAN_LIMIT_REACHED' }, HttpStatus.PAYMENT_REQUIRED);
    svc.withTenant.mockRejectedValueOnce(limitError);
    await expect(svc.withTenantSerializable('company-1', async () => 'ok')).rejects.toBe(limitError);
    expect(svc.withTenant).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget is exhausted', async () => {
    const svc = build();
    svc.withTenant.mockRejectedValue(serializationError());
    await expect(svc.withTenantSerializable('company-1', async () => 'ok', 2)).rejects.toMatchObject({ code: 'P2034' });
    expect(svc.withTenant).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
