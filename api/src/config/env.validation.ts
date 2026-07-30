/**
 * Fail-fast environment validation, run by `ConfigModule.forRoot({ validate })`
 * during boot — before a single request is served. A misconfigured process
 * should crash loudly at startup, not accept traffic and fail (or, worse,
 * silently under-secure itself) later.
 *
 * Dependency-free on purpose: no Joi / class-validator / zod. The surface is
 * small and stable, and a hand-rolled check keeps the boot path free of a
 * schema library the rest of the app doesn't use.
 *
 * Two tiers of strictness:
 *  - Always (every environment, including tests): the things the app cannot
 *    function without at all — the three database URLs, a JWT signing
 *    secret, and the Integration Hub's AES-256 credential-vault key. A
 *    missing one of these is never a valid configuration.
 *  - Production only (`NODE_ENV === 'production'`): the secret must actually be
 *    strong — at least 32 chars and not the in-repo placeholder. Dev and CI
 *    keep the frictionless weak secret from `.env.example`; a real deployment
 *    that ships that placeholder would make every session token forgeable, so
 *    we refuse to start.
 */

/** The placeholder secrets shipped in `.env.example` — never valid in production. */
const PLACEHOLDER_JWT_SECRET = 'local-dev-only-change-me';
const PLACEHOLDER_ADMIN_JWT_SECRET = 'local-dev-only-change-me-admin';
const MIN_PROD_SECRET_LENGTH = 32;

/**
 * The well-known dev-only Postgres role passwords from docker-compose.yml /
 * .env.example. If any of these ever appears in a production connection string
 * it means the deploy's password-rotation step (deploy-api.yml runs
 * db:rotate-role-passwords from Secrets Manager) didn't take — a fail-fast here
 * is far better than serving traffic with a guessable database credential.
 */
const DEV_ONLY_DB_PASSWORDS = [
  'fleetos_dev_only',
  'fleetos_app_dev_only',
  'fleetos_auth_dev_only',
  'fleetos_admin_dev_only',
];
const DB_URL_KEYS = ['DATABASE_URL', 'APP_DATABASE_URL', 'AUTH_DATABASE_URL', 'ADMIN_DATABASE_URL'] as const;

/** Env vars with no safe default: absence is always a fatal misconfiguration. */
const REQUIRED_ALWAYS = [
  'DATABASE_URL',
  'APP_DATABASE_URL',
  'AUTH_DATABASE_URL',
  'ADMIN_DATABASE_URL',
  'JWT_SECRET',
  'ADMIN_JWT_SECRET',
] as const;

/** AES-256-GCM key size — see IntegrationCryptoService. */
const INTEGRATION_KEY_BYTES = 32;

/**
 * Decodes `INTEGRATION_CREDENTIAL_KEY` as base64 or hex, returning the raw key
 * bytes iff it's exactly 32 bytes (AES-256). Shared with IntegrationCryptoService
 * so boot-time validation and runtime decoding can never disagree about what
 * counts as a valid key. A 64-hex-char string is unambiguous; anything else is
 * treated as base64 (Buffer.from silently drops invalid base64 characters
 * rather than throwing, so the 32-byte length check is what actually catches a
 * malformed value).
 */
export function decodeIntegrationCredentialKey(raw: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const decoded = Buffer.from(raw, 'base64');
  return decoded.length === INTEGRATION_KEY_BYTES ? decoded : null;
}

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const errors: string[] = [];
  const isProduction = config.NODE_ENV === 'production';

  for (const key of REQUIRED_ALWAYS) {
    const value = config[key];
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`${key} is required but was missing or empty.`);
    }
  }

  // The Integration Hub credential vault (IntegrationCryptoService) needs a
  // real AES-256 key to encrypt/decrypt at all — a missing or malformed key
  // must fail the boot, not the first credential a user tries to save.
  const integrationKeyRaw = typeof config.INTEGRATION_CREDENTIAL_KEY === 'string' ? config.INTEGRATION_CREDENTIAL_KEY : '';
  if (integrationKeyRaw.trim() === '') {
    errors.push('INTEGRATION_CREDENTIAL_KEY is required but was missing or empty.');
  } else if (!decodeIntegrationCredentialKey(integrationKeyRaw)) {
    errors.push(
      'INTEGRATION_CREDENTIAL_KEY must decode to exactly 32 bytes — base64 (e.g. `openssl rand -base64 32`) or 64 hex characters (e.g. `openssl rand -hex 32`).',
    );
  }

  // Production-strength check for the token signing secret. Only enforced in
  // production so local dev and the test suite can keep using the short
  // placeholder from .env.example without ceremony.
  if (isProduction) {
    const secret = typeof config.JWT_SECRET === 'string' ? config.JWT_SECRET : '';
    if (secret === PLACEHOLDER_JWT_SECRET) {
      errors.push(
        'JWT_SECRET is still the in-repo placeholder — set a unique, random secret per environment (every token would otherwise be forgeable).',
      );
    } else if (secret.length > 0 && secret.length < MIN_PROD_SECRET_LENGTH) {
      errors.push(
        `JWT_SECRET must be at least ${MIN_PROD_SECRET_LENGTH} characters in production (got ${secret.length}).`,
      );
    }

    const adminSecret = typeof config.ADMIN_JWT_SECRET === 'string' ? config.ADMIN_JWT_SECRET : '';
    if (adminSecret === PLACEHOLDER_ADMIN_JWT_SECRET) {
      errors.push(
        'ADMIN_JWT_SECRET is still the in-repo placeholder — set a unique, random secret per environment (every admin session token would otherwise be forgeable).',
      );
    } else if (adminSecret.length > 0 && adminSecret.length < MIN_PROD_SECRET_LENGTH) {
      errors.push(
        `ADMIN_JWT_SECRET must be at least ${MIN_PROD_SECRET_LENGTH} characters in production (got ${adminSecret.length}).`,
      );
    }
    if (adminSecret.length > 0 && adminSecret === secret) {
      errors.push('ADMIN_JWT_SECRET must not be the same value as JWT_SECRET — a shared secret would let a token signed for one audience be replayed against the other.');
    }

    // The dev-only database role passwords must never survive into production.
    for (const key of DB_URL_KEYS) {
      const url = typeof config[key] === 'string' ? (config[key] as string) : '';
      const leaked = DEV_ONLY_DB_PASSWORDS.find((pw) => url.includes(pw));
      if (leaked) {
        errors.push(
          `${key} still contains the dev-only database password "${leaked}" — rotate the DB role passwords (Secrets Manager) before serving production traffic.`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n  - ${errors.join('\n  - ')}\n` +
        'See apps/api/.env.example for the required variables.',
    );
  }

  return config;
}
