import { validateEnv } from './env.validation';

const base = {
  DATABASE_URL: 'postgresql://x',
  APP_DATABASE_URL: 'postgresql://x',
  AUTH_DATABASE_URL: 'postgresql://x',
  JWT_SECRET: 'local-dev-only-change-me',
  INTEGRATION_CREDENTIAL_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // 32 zero bytes, base64
};

describe('validateEnv', () => {
  it('accepts a complete dev config (weak secret allowed outside production)', () => {
    expect(() => validateEnv({ ...base })).not.toThrow();
  });

  it.each(['DATABASE_URL', 'APP_DATABASE_URL', 'AUTH_DATABASE_URL', 'JWT_SECRET', 'INTEGRATION_CREDENTIAL_KEY'])(
    'rejects when %s is missing',
    (key) => {
      const config = { ...base } as Record<string, unknown>;
      delete config[key];
      expect(() => validateEnv(config)).toThrow(new RegExp(key));
    },
  );

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
      validateEnv({ ...base, NODE_ENV: 'production', JWT_SECRET: 'short' }),
    ).toThrow(/at least 32/);
  });

  it('accepts a strong JWT secret in production', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_SECRET: 'a'.repeat(48),
      }),
    ).not.toThrow();
  });

  it('rejects a dev-only DB role password surviving into production', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        JWT_SECRET: 'a'.repeat(48),
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

  it('returns the config unchanged when valid', () => {
    const config = { ...base, EXTRA: 'keep-me' };
    expect(validateEnv(config)).toEqual(config);
  });
});
