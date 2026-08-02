import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The load-test seed creates real, loginable accounts sharing the well-known
 * dev password, exactly like seed-demo-company / seed-enterprise-company. It
 * must therefore go through the same production guard so a stray production
 * DATABASE_URL can never have ~default-password accounts seeded into it. This
 * asserts the guard is wired in (import + top-level call before any DB work),
 * matching its guarded siblings.
 */
describe('seed-load-test-data guard', () => {
  const source = readFileSync(join(__dirname, '..', 'scripts', 'seed-load-test-data.ts'), 'utf8');

  it('imports the shared seed guard', () => {
    expect(source).toMatch(/import\s+\{\s*assertSafeToSeed\s*\}\s+from\s+'\.\/seed-guard'/);
  });

  it("calls assertSafeToSeed('seed-load-test-data') before instantiating PrismaClient", () => {
    const guardIndex = source.indexOf("assertSafeToSeed('seed-load-test-data')");
    const prismaIndex = source.indexOf('new PrismaClient()');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(prismaIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(prismaIndex);
  });
});
