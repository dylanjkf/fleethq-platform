import { Test } from '@nestjs/testing';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../src/app.module';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { REQUIRED_PERMISSION_KEY } from '../src/common/decorators/require-permission.decorator';
import { AUTHENTICATED_ONLY_KEY } from '../src/common/decorators/authenticated-only.decorator';

/**
 * Structural enforcement of deny-by-default authorization (see PermissionGuard).
 *
 * Every controller route MUST declare exactly how it is protected — one of:
 *   • @Public()            — unauthenticated,
 *   • @RequirePermission() — gated on a granted permission, or
 *   • @AuthenticatedOnly() — authenticated but deliberately permission-free.
 *
 * A route that declares none would be DENIED at runtime by the guard; this test
 * fails the build first, so a forgotten @RequirePermission is caught in CI
 * rather than shipping as a 403 (or, before deny-by-default, as an accidental
 * allow-all). It only compiles the module (no DB connection needed).
 */
describe('route permission coverage', () => {
  it('classifies every controller route (Public | RequirePermission | AuthenticatedOnly)', async () => {
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
      const prototype = Object.getPrototypeOf(instance);
      for (const methodName of scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[methodName];
        if (typeof handler !== 'function') continue;
        // Only real route handlers carry PATH_METADATA (set by @Get/@Post/...).
        if (!Reflect.hasMetadata(PATH_METADATA, handler)) continue;

        const scope = [handler as (...args: unknown[]) => unknown, instance.constructor];
        const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, scope);
        const required = reflector.getAllAndOverride<string>(REQUIRED_PERMISSION_KEY, scope);
        const authOnly = reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY_KEY, scope);
        // Exactly one classification per route. Zero = a forgotten decorator
        // (denied at runtime). More than one = a contradiction (e.g. @Public()
        // AND @RequirePermission) that could resolve to unauthenticated-but-
        // ungated — both are build-time failures, not runtime surprises.
        const classifications = [isPublic, !!required, authOnly].filter(Boolean).length;
        const label = `${instance.constructor.name}.${methodName}`;
        if (classifications === 0) unclassified.push(label);
        if (classifications > 1) multiplyClassified.push(label);
      }
    }

    // If unclassified fails, add @RequirePermission (gated) or @AuthenticatedOnly
    // (intentionally permission-free) to each listed handler. If
    // multiplyClassified fails, remove the conflicting decorator so each route
    // declares exactly one protection mode.
    expect(unclassified).toEqual([]);
    expect(multiplyClassified).toEqual([]);

    await moduleRef.close();
  });
});
