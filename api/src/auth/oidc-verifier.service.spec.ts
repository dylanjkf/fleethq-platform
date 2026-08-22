import { ConfigService } from '@nestjs/config';
import { OAuthProvider } from '@prisma/client';
import { OidcVerifierService } from './oidc-verifier.service';

/**
 * Real signature-verification coverage for OidcVerifierService (audit Part 5).
 * Before this, only the PROVIDER_NOT_CONFIGURED (empty-audience) branch was
 * exercised — via auth-passwordless.e2e-spec.ts — while the load-bearing path
 * (RS256 signature against the IdP's JWKS, audience enforcement, issuer check,
 * required claims, the Microsoft GUID-tenant issuer regex) was untested. A social
 * login accepts an IdP id_token entirely on the strength of that path, so a
 * regression there — a dropped audience check, a loosened issuer regex — would
 * silently let a forged or wrong-audience token authenticate.
 *
 * `jose`'s createRemoteJWKSet is stubbed to return the public key of a keypair we
 * control (so no network JWKS fetch), while jwtVerify runs for real: we sign a
 * genuine RS256 token with the matching private key and assert the real crypto
 * accepts it — and rejects a foreign-key signature, a wrong audience, a bad
 * issuer, and a missing email.
 */
jest.mock('jose', () => ({ ...jest.requireActual('jose'), createRemoteJWKSet: jest.fn() }));
import { createRemoteJWKSet, generateKeyPair, SignJWT, type KeyLike } from 'jose';

const createRemoteJWKSetMock = createRemoteJWKSet as jest.MockedFunction<typeof createRemoteJWKSet>;

const GOOGLE = 'GOOGLE' as OAuthProvider;
const MICROSOFT = 'MICROSOFT' as OAuthProvider;
const GOOGLE_AUD = 'google-client-id.apps.googleusercontent.com';
const MS_AUD = 'microsoft-client-id';
const MS_TENANT_GUID = '11111111-2222-3333-4444-555555555555';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string, fallback?: string) => values[key] ?? fallback } as unknown as ConfigService;
}

/** The env of a fully-configured deployment (both providers, multi-tenant Microsoft). */
function enabledConfig(): ConfigService {
  return configWith({ GOOGLE_OAUTH_CLIENT_ID: GOOGLE_AUD, MICROSOFT_OAUTH_CLIENT_ID: MS_AUD });
}

describe('OidcVerifierService (real RS256 verification)', () => {
  let signingKey: KeyLike; // used to sign test tokens
  let publicKey: KeyLike; // matches signingKey; what the stubbed JWKS returns
  let foreignKey: KeyLike; // an unrelated private key, for the bad-signature case

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    signingKey = pair.privateKey;
    publicKey = pair.publicKey;
    foreignKey = (await generateKeyPair('RS256')).privateKey;
  });

  beforeEach(() => {
    createRemoteJWKSetMock.mockReset();
    // The IdP's JWKS resolves to the public half of our signing key. jose calls
    // this getter with (protectedHeader, token) and uses the returned key to
    // verify the signature — so the real RS256 check runs against a key we own.
    createRemoteJWKSetMock.mockReturnValue((async () => publicKey) as unknown as ReturnType<typeof createRemoteJWKSet>);
  });

  async function signToken(
    key: KeyLike,
    claims: Record<string, unknown>,
    opts: { issuer: string; audience: string; subject?: string },
  ): Promise<string> {
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(opts.issuer)
      .setAudience(opts.audience)
      .setIssuedAt()
      .setExpirationTime('5m');
    if (opts.subject) jwt.setSubject(opts.subject);
    return jwt.sign(key);
  }

  describe('Google', () => {
    it('accepts a correctly-signed token with the right audience, issuer, and claims', async () => {
      const service = new OidcVerifierService(enabledConfig());
      const token = await signToken(signingKey, { email: 'driver@corp.example', email_verified: true }, {
        issuer: 'https://accounts.google.com',
        audience: GOOGLE_AUD,
        subject: 'google-sub-123',
      });

      await expect(service.verify(GOOGLE, token)).resolves.toEqual({
        subject: 'google-sub-123',
        email: 'driver@corp.example',
        emailVerified: true,
      });
    });

    it('reports emailVerified=false when Google says the email is unverified', async () => {
      const service = new OidcVerifierService(enabledConfig());
      const token = await signToken(signingKey, { email: 'driver@corp.example', email_verified: false }, {
        issuer: 'https://accounts.google.com',
        audience: GOOGLE_AUD,
        subject: 'google-sub-123',
      });

      await expect(service.verify(GOOGLE, token)).resolves.toMatchObject({ emailVerified: false });
    });

    it('accepts the string "true" form of email_verified (Google sends it both ways)', async () => {
      const service = new OidcVerifierService(enabledConfig());
      const token = await signToken(signingKey, { email: 'driver@corp.example', email_verified: 'true' }, {
        issuer: 'https://accounts.google.com',
        audience: GOOGLE_AUD,
        subject: 'google-sub-123',
      });

      await expect(service.verify(GOOGLE, token)).resolves.toMatchObject({ emailVerified: true });
    });

    it('rejects a token whose audience is a DIFFERENT client id (token minted for another app)', async () => {
      const service = new OidcVerifierService(enabledConfig());
      const token = await signToken(signingKey, { email: 'driver@corp.example', email_verified: true }, {
        issuer: 'https://accounts.google.com',
        audience: 'some-other-app-client-id', // not GOOGLE_AUD
        subject: 'google-sub-123',
      });

      await expect(service.verify(GOOGLE, token)).rejects.toMatchObject({ response: { code: 'INVALID_ID_TOKEN' } });
    });

    it('rejects a token signed by a key that is NOT in the IdP JWKS (forged signature)', async () => {
      const service = new OidcVerifierService(enabledConfig());
      // Signed with foreignKey, but the JWKS only holds publicKey → signature fails.
      const token = await signToken(foreignKey, { email: 'attacker@evil.example', email_verified: true }, {
        issuer: 'https://accounts.google.com',
        audience: GOOGLE_AUD,
        subject: 'attacker-sub',
      });

      await expect(service.verify(GOOGLE, token)).rejects.toMatchObject({ response: { code: 'INVALID_ID_TOKEN' } });
    });

    it('rejects a validly-signed, right-audience token from an unexpected issuer', async () => {
      const service = new OidcVerifierService(enabledConfig());
      const token = await signToken(signingKey, { email: 'driver@corp.example', email_verified: true }, {
        issuer: 'https://accounts.google.com.evil.example', // signature + audience valid, issuer is not Google
        audience: GOOGLE_AUD,
        subject: 'google-sub-123',
      });

      await expect(service.verify(GOOGLE, token)).rejects.toMatchObject({
        response: { code: 'INVALID_ID_TOKEN', message: 'Unexpected token issuer.' },
      });
    });

    it('rejects a valid token that carries no email claim', async () => {
      const service = new OidcVerifierService(enabledConfig());
      const token = await signToken(signingKey, { email_verified: true }, {
        issuer: 'https://accounts.google.com',
        audience: GOOGLE_AUD,
        subject: 'google-sub-123',
      });

      await expect(service.verify(GOOGLE, token)).rejects.toMatchObject({
        response: { code: 'INVALID_ID_TOKEN', message: 'That sign-in token did not include an email address.' },
      });
    });

    it('refuses when the provider is not configured (no client id set) — never reaches verification', async () => {
      const service = new OidcVerifierService(configWith({})); // GOOGLE_OAUTH_CLIENT_ID unset
      await expect(service.verify(GOOGLE, 'any.token.here')).rejects.toMatchObject({
        response: { code: 'PROVIDER_NOT_CONFIGURED' },
      });
      // The JWKS/verify path is never entered when unconfigured.
      expect(createRemoteJWKSetMock).not.toHaveBeenCalled();
    });
  });

  describe('Microsoft', () => {
    it('accepts a multi-tenant ("common") token whose issuer matches the GUID-tenant pattern, verified by construction', async () => {
      const service = new OidcVerifierService(enabledConfig()); // tenant defaults to "common"
      const token = await signToken(signingKey, { email: 'ops@corp.example' }, {
        issuer: `https://login.microsoftonline.com/${MS_TENANT_GUID}/v2.0`,
        audience: MS_AUD,
        subject: 'ms-sub-123',
      });

      // Microsoft v2 tokens carry no email_verified; a first-party issuer is trusted.
      await expect(service.verify(MICROSOFT, token)).resolves.toEqual({
        subject: 'ms-sub-123',
        email: 'ops@corp.example',
        emailVerified: true,
      });
    });

    it('rejects a "common" token whose issuer tenant is not a GUID (issuer-regex guard)', async () => {
      const service = new OidcVerifierService(enabledConfig());
      const token = await signToken(signingKey, { email: 'ops@corp.example' }, {
        issuer: 'https://login.microsoftonline.com/not-a-guid/v2.0',
        audience: MS_AUD,
        subject: 'ms-sub-123',
      });

      await expect(service.verify(MICROSOFT, token)).rejects.toMatchObject({
        response: { code: 'INVALID_ID_TOKEN', message: 'Unexpected token issuer.' },
      });
    });

    it('pins the issuer exactly when a single tenant GUID is configured', async () => {
      const service = new OidcVerifierService(
        configWith({ MICROSOFT_OAUTH_CLIENT_ID: MS_AUD, MICROSOFT_OAUTH_TENANT_ID: MS_TENANT_GUID }),
      );
      // A token from a DIFFERENT tenant GUID — valid signature and audience, but
      // the wrong directory for a single-tenant deployment.
      const otherTenant = '99999999-8888-7777-6666-555555555555';
      const token = await signToken(signingKey, { email: 'ops@corp.example' }, {
        issuer: `https://login.microsoftonline.com/${otherTenant}/v2.0`,
        audience: MS_AUD,
        subject: 'ms-sub-123',
      });

      await expect(service.verify(MICROSOFT, token)).rejects.toMatchObject({
        response: { code: 'INVALID_ID_TOKEN', message: 'Unexpected token issuer.' },
      });
    });
  });

  describe('isConfigured', () => {
    it('reflects whether each provider client id is set', () => {
      const both = new OidcVerifierService(enabledConfig());
      expect(both.isConfigured(GOOGLE)).toBe(true);
      expect(both.isConfigured(MICROSOFT)).toBe(true);

      const neither = new OidcVerifierService(configWith({}));
      expect(neither.isConfigured(GOOGLE)).toBe(false);
      expect(neither.isConfigured(MICROSOFT)).toBe(false);
    });
  });
});
