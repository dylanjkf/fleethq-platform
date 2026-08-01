import { ADMIN_PERMISSION_CATALOG, ADMIN_PERMISSIONS } from './admin-permission-catalog';

describe('admin permission catalog', () => {
  it('every entry key follows the resource:action convention', () => {
    for (const entry of ADMIN_PERMISSION_CATALOG) {
      expect(entry.key).toMatch(/^[a-z]+(_[a-z]+)*:[a-z]+$/);
    }
  });

  it('has no duplicate keys', () => {
    const keys = ADMIN_PERMISSION_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every ADMIN_PERMISSIONS constant is present in the catalog', () => {
    const catalogKeys = new Set(ADMIN_PERMISSION_CATALOG.map((e) => e.key));
    for (const key of Object.values(ADMIN_PERMISSIONS)) {
      expect(catalogKeys.has(key)).toBe(true);
    }
  });

  it('every catalog key has a corresponding ADMIN_PERMISSIONS constant', () => {
    const constantKeys = new Set(Object.values(ADMIN_PERMISSIONS));
    for (const entry of ADMIN_PERMISSION_CATALOG) {
      expect(constantKeys.has(entry.key)).toBe(true);
    }
  });
});
