import 'reflect-metadata';
import { PATH_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminUsersController } from './admin-users.controller';
import { REQUIRED_ADMIN_PERMISSION_KEY } from '../admin-auth/decorators/require-admin-permission.decorator';
import { AdminJwtAuthGuard } from '../admin-auth/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../admin-auth/guards/admin-permission.guard';
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';

/**
 * Local mirror of test/admin-route-permission-coverage.spec.ts, scoped to the
 * new controller so it fails fast (and without a live DB / the whole AppModule)
 * if a route ever drops its `@AdminGuarded()` or classification decorator.
 * Every route must carry both admin guards and exactly one required admin
 * permission from the `admin_users:*` pair.
 */
describe('AdminUsersController route protection', () => {
  const prototype = AdminUsersController.prototype;
  const routeMethods = Object.getOwnPropertyNames(prototype).filter(
    (name) => name !== 'constructor' && Reflect.hasMetadata(PATH_METADATA, (prototype as unknown as Record<string, unknown>)[name] as object),
  );

  it('exposes the expected CRUD routes', () => {
    expect(routeMethods.sort()).toEqual(['create', 'deactivate', 'getById', 'list', 'listRoles', 'reactivate', 'updateRole']);
  });

  it.each(['list', 'listRoles', 'getById', 'create', 'updateRole', 'deactivate', 'reactivate'])(
    'route "%s" carries both admin guards',
    (methodName) => {
      const handler = (prototype as unknown as Record<string, unknown>)[methodName] as object;
      const methodGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? [];
      const classGuards = (Reflect.getMetadata(GUARDS_METADATA, AdminUsersController) as unknown[] | undefined) ?? [];
      const guards = [...classGuards, ...methodGuards];
      expect(guards).toContain(AdminJwtAuthGuard);
      expect(guards).toContain(AdminPermissionGuard);
    },
  );

  it('gates view routes with admin_users:view and mutations with admin_users:manage', () => {
    const permOf = (methodName: string) =>
      Reflect.getMetadata(REQUIRED_ADMIN_PERMISSION_KEY, (prototype as unknown as Record<string, unknown>)[methodName] as object);
    expect(permOf('list')).toBe(ADMIN_PERMISSIONS.ADMIN_USERS_VIEW);
    expect(permOf('listRoles')).toBe(ADMIN_PERMISSIONS.ADMIN_USERS_VIEW);
    expect(permOf('getById')).toBe(ADMIN_PERMISSIONS.ADMIN_USERS_VIEW);
    for (const m of ['create', 'updateRole', 'deactivate', 'reactivate']) {
      expect(permOf(m)).toBe(ADMIN_PERMISSIONS.ADMIN_USERS_MANAGE);
    }
  });
});
