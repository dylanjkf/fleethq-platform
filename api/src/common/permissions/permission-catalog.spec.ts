import { PERMISSION_CATALOG, PERMISSIONS } from './permission-catalog';

describe('permission catalog', () => {
  it('every entry key follows the resource:action convention', () => {
    for (const entry of PERMISSION_CATALOG) {
      expect(entry.key).toMatch(/^[a-z]+(_[a-z]+)*:[a-z]+$/);
    }
  });

  it('has no duplicate keys', () => {
    const keys = PERMISSION_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never grants a bare "delete" action — archiving is the only destructive verb', () => {
    for (const entry of PERMISSION_CATALOG) {
      expect(entry.key.endsWith(':delete')).toBe(false);
    }
  });

  it('every PERMISSIONS constant is present in the catalog', () => {
    const catalogKeys = new Set(PERMISSION_CATALOG.map((e) => e.key));
    for (const key of Object.values(PERMISSIONS)) {
      expect(catalogKeys.has(key)).toBe(true);
    }
  });
});
