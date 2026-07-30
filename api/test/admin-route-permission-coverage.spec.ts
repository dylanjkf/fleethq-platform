import { Test } from '@nestjs/testing';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../src/app.module';
import { ADMIN_AUTHENTICATED_ONLY_KEY } from '../src/admin-auth/decorators/admin-authenticated-only.decorator';
import { REQUIRED_ADMIN_PERMISSION_KEY } from '../src/admin-auth/decorators/require-admin-permission.decorator';

/**
 * The admin platform's equivalent of route-permission-coverage.spec.ts —
 * every /admin/v1 route must declare itself as exactly one of
 * `@AdminAuthenticatedOnly()` or `@RequireAdminPermission()`, enforced by
 * `AdminPermissionGuard` at runtime. This is the build-time backstop: a
 * forgotten decorator fails CI here instead of shipping as a silent 403 (or,
 * worse, being caught by AdminPermissionGuard's deny-by-default at runtime
 * only after a real admin hits it in production).
 *
 * `login` and `mfa/verify` are the only two genuinely unauthenticated admin
 * routes (see AdminAuthController's docstring) — they carry neither
 * classification on purpose and are explicitly allowlisted below rather than
 * silently excluded from the scan.
 */
const EXEMPT: Record<string, string[]> = {
  AdminAuthController: ['login', 'verifyMfa'],
};

describe('admin route permission coverage', () => {
  it('classifies every /admin/v1 controller route (AdminAuthenticatedOnly | RequireAdminPermission)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, DiscoveryModule],
    }).compile();

    const discovery = moduleRef.get(DiscoveryService);
    const scanner = moduleRef.get(MetadataScanner);
    const reflector = moduleRef.get(Reflector);

    const unclassified: string[] = [];
    const multiplyClassified: string[] = [];
    for (const wrapper of discovery.getControllers()) {
      const instance = wrapper.instance as object | undefined;
      if (!instance) continue;
      const className = instance.constructor.name;
      if (!className.startsWith('Admin')) continue;

      const prototype = Object.getPrototypeOf(instance);
      for (const methodName of scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[methodName];
        if (typeof handler !== 'function') continue;
        if (!Reflect.hasMetadata(PATH_METADATA, handler)) continue;
        if (EXEMPT[className]?.includes(methodName)) continue;

        const scope = [handler as (...args: unknown[]) => unknown, instance.constructor];
        const authOnly = reflector.getAllAndOverride<boolean>(ADMIN_AUTHENTICATED_ONLY_KEY, scope);
        const required = reflector.getAllAndOverride<string>(REQUIRED_ADMIN_PERMISSION_KEY, scope);
        const classifications = [authOnly, !!required].filter(Boolean).length;
        const label = `${className}.${methodName}`;
        if (classifications === 0) unclassified.push(label);
        if (classifications > 1) multiplyClassified.push(label);
      }
    }

    expect(unclassified).toEqual([]);
    expect(multiplyClassified).toEqual([]);

    await moduleRef.close();
  });
});
