/**
 * Shared guard for the demo/enterprise seed scripts, which create real,
 * loginable tenant accounts sharing a well-known dev password. `prisma/seed.ts`
 * already refuses to create demo companies when NODE_ENV=production; these
 * newer scripts previously had no guard at all, so an engineer with a
 * production DATABASE_URL in their shell could seed ~190 default-password
 * accounts straight into production. This closes that: it refuses to run in
 * production AND refuses any DATABASE_URL host not on the non-production
 * allowlist, so a stray production connection string is rejected even if
 * NODE_ENV happens to be unset.
 */

/** Hostnames that are unambiguously local/non-production. */
const NON_PRODUCTION_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres', 'db', 'database']);

export function assertSafeToSeed(scriptName: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Refusing to run ${scriptName}: NODE_ENV=production. This script creates default-password demo accounts and must never touch production.`);
  }

  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (!databaseUrl) {
    throw new Error(`Refusing to run ${scriptName}: DATABASE_URL is not set.`);
  }

  let host: string;
  try {
    // Prisma URLs are standard postgresql:// URLs, so URL can parse the host.
    host = new URL(databaseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    throw new Error(`Refusing to run ${scriptName}: DATABASE_URL is not a parseable connection string.`);
  }

  const allowlist = process.env.SEED_ALLOWED_DB_HOSTS
    ? new Set(process.env.SEED_ALLOWED_DB_HOSTS.split(',').map((h) => h.trim().toLowerCase()))
    : NON_PRODUCTION_DB_HOSTS;

  if (!allowlist.has(host)) {
    throw new Error(
      `Refusing to run ${scriptName}: DATABASE_URL host "${host}" is not on the non-production allowlist ` +
        `(${[...allowlist].join(', ')}). If this really is a disposable non-production database, set ` +
        `SEED_ALLOWED_DB_HOSTS to include it.`,
    );
  }
}
