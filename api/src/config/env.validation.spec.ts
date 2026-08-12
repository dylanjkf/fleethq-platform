import { validateEnv } from './env.validation';

const base = {
  DATABASE_URL: 'postgresql://x',
  APP_DATABASE_URL: 'postgresql://x',
  AUTH_DATABASE_URL: 'postgresql://x',
  ADMIN_DATABASE_URL: 'postgresql://x',
  JWT_SECRET: 'local-dev-only-change-me',
  ADMIN_JWT_SECRET: 'local-dev-only-change-me-admin',
  INTEGRATION_CREDENTIAL_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // 32 zero bytes, base64
};

describe('validateEnv', () => {
  it('accepts a complete dev config (weak secret allowed outside production)', () => {
    expect(() => validateEnv({ ...base })).not.toThrow();
  });

  it.each([
    'DATABASE_URL',
    'APP_DATABASE_URL',
    'AUTH_DATABASE_URL',
    'ADMIN_DATABASE_URL',
    'JWT_SECRET',
    'ADMIN_JWT_SECRET',
    'INTEGRATION_CREDENTIAL_KEY',
  ])('rejects when %s is missing', (key) => {
    const config = { ...base } as Record<string, unknown>;
    delete config[key];
    expect(() => validateEnv(config)).toThrow(new RegExp(key));
  });

  it('rejects a malformed INTEGRATION_CREDENTIAL_KEY (wrong byte length)', () => {
    expect(() => validateEnv({ ...base, INTEGRATION_CREDENTIAL_KEY: 'not-a-real-key' })).toThrow(
      /INTEGRATION_CREDENTIAL_KEY must decode/,
    );
  });

  it('accepts a 64-char hex INTEGRATION_CREDENTIAL_KEY', () => {
    expect(() => validateEnv({ ...base, INTEGRATION_CREDENTIAL_KEY: 'a'.repeat(64) })).not.toThrow();
  });

  it('rejects an empty/whitespace required value', () => {
    expect(() => validateEnv({ ...base, APP_DATABASE_URL: '   ' })).toThrow(/APP_DATABASE_URL/);
  });

  it('rejects the placeholder JWT secret in production', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(/placeholder/i);
  });

  it('rejects a too-short JWT secret in production', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', JWT_SECRET: 'short', ADMIN_JWT_SECRET: 'b'.repeat(48) }),
    ).toThrow(/at least 32/);
  });

  it('rejects the placeholder ADMIN_JWT_SECRET in production', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(48) }),
    ).toThrow(/ADMIN_JWT_SECRET is still the in-repo placeholder/);
  });

  it('rejects a too-short ADMIN_JWT_SECRET in production', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(48), ADMIN_JWT_SECRET: 'short' }),
    ).toThrow(/ADMIN_JWT_SECRET must be at least 32/);
  });

  it('rejects ADMIN_JWT_SECRET being equal to JWT_SECRET in production', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_SECRET: 'a'.repeat(48),
        ADMIN_JWT_SECRET: 'a'.repeat(48),
      }),
    ).toThrow(/must not be the same value as JWT_SECRET/);
  });

  it('accepts a strong JWT secret and ADMIN_JWT_SECRET in production', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_SECRET: 'a'.repeat(48),
        ADMIN_JWT_SECRET: 'b'.repeat(48),
        APP_BASE_URL: 'https://app.fleetos.example',
      }),
    ).not.toThrow();
  });

  it('requires APP_BASE_URL in production (unset silently disables signup + points email links at localhost)', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(48), ADMIN_JWT_SECRET: 'b'.repeat(48) }),
    ).toThrow(/APP_BASE_URL is required in production/);
  });

  it('rejects a non-URL APP_BASE_URL in production', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_SECRET: 'a'.repeat(48),
        ADMIN_JWT_SECRET: 'b'.repeat(48),
        APP_BASE_URL: 'app.fleetos.example',
      }),
    ).toThrow(/APP_BASE_URL must be an absolute http\(s\) URL/);
  });

  it('does not require APP_BASE_URL outside production (dev/test fall back to localhost)', () => {
    expect(() => validateEnv({ ...base })).not.toThrow();
  });

  it('rejects a dev-only DB role password surviving into production', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_SECRET: 'a'.repeat(48),
        ADMIN_JWT_SECRET: 'b'.repeat(48),
        APP_DATABASE_URL: 'postgresql://fleetos_app:fleetos_app_dev_only@db:5432/fleetos',
      }),
    ).toThrow(/dev-only database password/i);
  });

  it('allows dev-only DB passwords outside production', () => {
    expect(() =>
      validateEnv({
        ...base,
        APP_DATABASE_URL: 'postgresql://fleetos_app:fleetos_app_dev_only@localhost:5432/fleetos',
      }),
    ).not.toThrow();
  });

  it('rejects the in-repo INTEGRATION_CREDENTIAL_KEY placeholder in production', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_SECRET: 'a'.repeat(48),
        ADMIN_JWT_SECRET: 'b'.repeat(48),
        INTEGRATION_CREDENTIAL_KEY: 'Q0hBTkdFLU1FLWRldi1vbmx5LW5vdC1mb3ItcHJvZCE=',
      }),
    ).toThrow(/INTEGRATION_CREDENTIAL_KEY is still the in-repo example key/);
  });

  it('also rejects the historically-committed INTEGRATION_CREDENTIAL_KEY in production', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_SECRET: 'a'.repeat(48),
        ADMIN_JWT_SECRET: 'b'.repeat(48),
        INTEGRATION_CREDENTIAL_KEY: 'JdKT12mhp2Qmo/Hh9ml7kOgmb6CZsMeSe+wW6ViXam0=',
      }),
    ).toThrow(/INTEGRATION_CREDENTIAL_KEY is still the in-repo example key/);
  });

  it('allows the placeholder INTEGRATION_CREDENTIAL_KEY outside production (dev/CI)', () => {
    expect(() =>
      validateEnv({ ...base, INTEGRATION_CREDENTIAL_KEY: 'Q0hBTkdFLU1FLWRldi1vbmx5LW5vdC1mb3ItcHJvZCE=' }),
    ).not.toThrow();
  });

  it('returns the config unchanged when valid', () => {
    const config = { ...base, EXTRA: 'keep-me' };
    expect(validateEnv(config)).toEqual(config);
  });
});
