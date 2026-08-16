/**
 * Read-only diagnostic for the Titan demo login.
 *
 * It answers one question: does the database this connects to actually contain
 * a working `admin@titan` credential for the given password — the exact check
 * the live login performs (username lookup + bcrypt compare)? It writes
 * NOTHING, so it is safe to point at any database, including production.
 *
 * Run from the "Diagnose Titan login" workflow, which points DATABASE_URL at
 * SEED_DATABASE_URL (the DB the seed writes to) so we can compare its result
 * against the live endpoint's result and tell whether the API authenticates
 * against this same database.
 */
import './load-env';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const ADMIN_USERNAME = process.env.TITAN_ADMIN_USERNAME ?? 'admin@titan';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  const password = process.env.TITAN_ADMIN_PASSWORD ?? '';

  // Never print the credential itself; do show which DB/host we hit.
  let hostLabel = '(unparseable)';
  try {
    const u = new URL(url);
    hostLabel = `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    /* ignore */
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const [{ current_database, current_user }] = await prisma.$queryRawUnsafe<
      { current_database: string; current_user: string }[]
    >('SELECT current_database(), current_user');
    console.log(`Connected to host   : ${hostLabel}`);
    console.log(`current_database()  : ${current_database}`);
    console.log(`current_user        : ${current_user}`);

    const totalUsers = await prisma.user.count();
    console.log(`total users in db   : ${totalUsers}`);

    const user = await prisma.user.findUnique({ where: { username: ADMIN_USERNAME } });
    if (!user) {
      console.log(`\n❌ No user with username "${ADMIN_USERNAME}" exists in THIS database.`);
      console.log('   → The live API is almost certainly authenticating against a DIFFERENT database.');
      return;
    }

    console.log(`\nUser row found:`);
    console.log(`  id                : ${user.id}`);
    console.log(`  username          : ${user.username}`);
    console.log(`  archivedAt        : ${user.archivedAt ? user.archivedAt.toISOString() : 'null (active)'}`);
    console.log(`  lockedUntil       : ${user.lockedUntil ? user.lockedUntil.toISOString() : 'null (not locked)'}`);
    console.log(`  failedLoginCount  : ${user.failedLoginCount}`);
    console.log(`  passwordHash algo : ${user.passwordHash.slice(0, 4)} (len ${user.passwordHash.length})`);

    if (!password) {
      console.log('\n(no TITAN_ADMIN_PASSWORD supplied — skipping bcrypt compare)');
    } else {
      const ok = await bcrypt.compare(password, user.passwordHash);
      console.log(`\nbcrypt.compare(supplied password, storedHash) = ${ok}`);
      console.log(
        ok
          ? '✅ THIS database would accept the supplied password for admin@titan.'
          : '❌ THIS database has admin@titan but the stored hash does NOT match the supplied password.',
      );
    }

    // Show the company + membership so we know the tenant is wired up.
    const memberships = await prisma.companyMembership.findMany({
      where: { userId: user.id },
      include: { company: { select: { name: true, archivedAt: true } } },
    });
    console.log(`\nmemberships (${memberships.length}):`);
    for (const m of memberships) {
      console.log(`  - ${m.company.name}${m.company.archivedAt ? ' (ARCHIVED)' : ''}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
