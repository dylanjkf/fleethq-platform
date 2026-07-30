/**
 * Loads apps/api/.env for standalone scripts that talk to the database
 * directly (seeds, permission reconciliation, role-password rotation, load
 * tests) — the actual NestJS app doesn't need this, since ConfigModule.forRoot
 * loads its own env there. `@prisma/client`'s generated runtime does a
 * best-effort auto-load of a CWD-relative `.env`, but that's silently
 * fragile: it only finds the file if the process's current working directory
 * happens to be apps/api, which isn't guaranteed by every way of invoking an
 * npm script (bare `ts-node`, an npm-workspaces command run from the repo
 * root, an IDE task, etc.) — hence "works on one machine, 'DATABASE_URL not
 * found' on another" for the exact same command.
 *
 * Resolved from this file's own location, so it finds apps/api/.env
 * regardless of the caller's cwd. Import this FIRST, before anything that
 * reads process.env (in particular before `new PrismaClient()`).
 *
 * dotenv never overwrites a variable already set in the real process
 * environment, and silently no-ops if the file doesn't exist (CI/containers
 * that inject env vars directly, with no .env file present, are unaffected).
 */
import { config } from 'dotenv';
import { join } from 'path';

config({ path: join(__dirname, '..', '.env') });
