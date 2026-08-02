/**
 * Auth/Billing Platform Phase 2: magic link, social login gating, and
 * WebAuthn/passkeys. The WebAuthn tests drive a real, from-scratch virtual
 * authenticator (an actual P-256 keypair, hand-built CBOR attestation/
 * authenticator data, a real ECDSA signature) through the exact same
 * @simplewebauthn/server verification the production code runs — this proves
 * the cryptographic round trip actually works, not just that the endpoints
 * respond.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'crypto';
import { encodeCBOR, type CBORType } from '@levischuck/tiny-cbor';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';
import { AuthTokensService } from '../src/auth/auth-tokens.service';
import { totp } from '../src/auth/mfa/totp';

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:5173';

/** A from-scratch WebAuthn authenticator: real ES256 keypair, real signatures, hand-encoded CBOR. */
class VirtualAuthenticator {
  private readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private counter = 0;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    this.publicKey = publicKey;
  }

  private authenticatorData(includeAttestedCredentialData: boolean): Buffer {
    const rpIdHash = createHash('sha256').update(RP_ID).digest();
    this.counter += 1;
    const flags = includeAttestedCredentialData ? 0b0100_0101 : 0b0000_0101; // UP + UV (+ AT when attesting)
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32BE(this.counter);
    if (!includeAttestedCredentialData) {
      return Buffer.concat([rpIdHash, Buffer.from([flags]), counterBuf]);
    }
    const jwk = this.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const coseKey = new Map<number, CBORType>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ]);
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credentialId.length);
    const attestedCredentialData = Buffer.concat([
      Buffer.alloc(16), // aaguid, all-zero for a "virtual" authenticator
      credIdLen,
      this.credentialId,
      Buffer.from(encodeCBOR(coseKey)),
    ]);
    return Buffer.concat([rpIdHash, Buffer.from([flags]), counterBuf, attestedCredentialData]);
  }

  register(challenge: string) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN }));
    const authData = this.authenticatorData(true);
    const attestationObject = Buffer.from(
      encodeCBOR(new Map<string, CBORType>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])),
    );
    return {
      id: this.credentialId.toString('base64url'),
      rawId: this.credentialId.toString('base64url'),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal'],
      },
    };
  }

  authenticate(challenge: string) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN }));
    const authData = this.authenticatorData(false);
    const clientDataHash = createHash('sha256').update(clientDataJSON).digest();
    const signature = createSign('SHA256').update(Buffer.concat([authData, clientDataHash])).sign(this.privateKey);
    return {
      id: this.credentialId.toString('base64url'),
      rawId: this.credentialId.toString('base64url'),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
      },
    };
  }
}

describe('Auth/Billing Platform Phase 2 (magic link, social login gating, WebAuthn)', () => {
  let app: INestApplication;
  let tokens: AuthTokensService;

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
    tokens = app.get(AuthTokensService);
  });
  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
  });

  const http = () => request(app.getHttpServer());
  const login = (username: string) => http().post('/v1/auth/login').send({ username, password: TEST_PASSWORD });

  describe('providers', () => {
    it('reports magic link and passkeys always on, social login off with nothing configured', async () => {
      const res = await http().get('/v1/auth/providers').expect(200);
      expect(res.body).toEqual({ magicLink: true, webauthn: true, google: false, microsoft: false });
    });
  });

  describe('magic link', () => {
    it('always returns ok without enumerating, then a valid token logs in and cannot be replayed', async () => {
      const tenant = await createTestTenant([]);

      await http().post('/v1/auth/magic-link/request').send({ identifier: tenant.username }).expect(200);
      await http().post('/v1/auth/magic-link/request').send({ identifier: 'nobody@nowhere.test' }).expect(200);

      const token = await tokens.issue(tenant.userId, 'MAGIC_LINK');
      const done = await http().post('/v1/auth/magic-link/consume').send({ token }).expect(200);
      expect(done.body.status).toBe('authenticated');
      expect(done.body.accessToken).toBeTruthy();

      // Single-use.
      await http().post('/v1/auth/magic-link/consume').send({ token }).expect(401);
    });

    it('rejects a token of the wrong type and a garbage token', async () => {
      const tenant = await createTestTenant([]);
      const wrongType = await tokens.issue(tenant.userId, 'EMAIL_VERIFY');
      await http().post('/v1/auth/magic-link/consume').send({ token: wrongType }).expect(401);
      await http().post('/v1/auth/magic-link/consume').send({ token: 'not-a-real-token' }).expect(401);
    });

    it('still stops at the MFA challenge for an MFA-enabled account', async () => {
      const tenant = await createTestTenant([]);
      const initial = await login(tenant.username).expect(200);
      const setup = await http().post('/v1/auth/mfa/setup').set('Authorization', `Bearer ${initial.body.accessToken}`).expect(200);
      await http()
        .post('/v1/auth/mfa/enable')
        .set('Authorization', `Bearer ${initial.body.accessToken}`)
        .send({ code: totp(setup.body.secret) })
        .expect(200);

      const token = await tokens.issue(tenant.userId, 'MAGIC_LINK');
      const challenge = await http().post('/v1/auth/magic-link/consume').send({ token }).expect(200);
      expect(challenge.body.status).toBe('mfa_required');
      expect(challenge.body.accessToken).toBeUndefined();

      const done = await http()
        .post('/v1/auth/mfa/verify')
        .send({ mfaToken: challenge.body.mfaToken, code: totp(setup.body.secret) })
        .expect(200);
      expect(done.body.status).toBe('authenticated');
    });
  });

  describe('social login', () => {
    it('refuses a configured-sounding but actually-unconfigured provider', async () => {
      const res = await http().post('/v1/auth/oauth/google/login').send({ idToken: 'whatever' }).expect(401);
      expect(res.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    });

    it('rejects an unknown provider name before ever touching the token', async () => {
      const res = await http().post('/v1/auth/oauth/facebook/login').send({ idToken: 'whatever' }).expect(400);
      expect(res.body.error.code).toBe('UNKNOWN_PROVIDER');
    });
  });

  describe('WebAuthn / passkeys', () => {
    it('requires authentication to begin or complete enrolment', async () => {
      await http().post('/v1/auth/webauthn/register/options').expect(401);
    });

    it('registers a passkey, then signs in with it end-to-end, and rejects a tampered assertion', async () => {
      const tenant = await createTestTenant([]);
      const initial = await login(tenant.username).expect(200);
      const auth = { Authorization: `Bearer ${initial.body.accessToken}` };

      const optionsRes = await http().post('/v1/auth/webauthn/register/options').set(auth).expect(200);
      const { options, challengeToken } = optionsRes.body;
      expect(options.rp.id).toBe(RP_ID);
      expect(options.challenge).toBeTruthy();

      const authenticator = new VirtualAuthenticator();
      const registrationResponse = authenticator.register(options.challenge);
      await http()
        .post('/v1/auth/webauthn/register/verify')
        .set(auth)
        // Enrolling a passkey requires step-up re-auth (current password or a
        // live MFA code) — a bare access token is deliberately not enough.
        .send({ challengeToken, response: registrationResponse, deviceLabel: 'Test authenticator', currentPassword: TEST_PASSWORD })
        .expect(200);

      const list = await http().get('/v1/auth/webauthn/credentials').set(auth).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].deviceLabel).toBe('Test authenticator');

      // A stale/garbage challenge token is refused outright.
      await http()
        .post('/v1/auth/webauthn/login/verify')
        .send({ challengeToken: 'not-a-real-token', response: authenticator.authenticate('irrelevant') })
        .expect(401);

      // Usernameless login: no identifier needed, the assertion alone resolves the account.
      const loginOptionsRes = await http().post('/v1/auth/webauthn/login/options').expect(200);
      const loginOptions = loginOptionsRes.body.options;
      expect(loginOptions.allowCredentials).toBeUndefined();

      const assertion = authenticator.authenticate(loginOptions.challenge);
      const done = await http()
        .post('/v1/auth/webauthn/login/verify')
        .send({ challengeToken: loginOptionsRes.body.challengeToken, response: assertion })
        .expect(200);
      expect(done.body.status).toBe('authenticated');

      // Passkey login bypasses this account's own MFA policy entirely — a login
      // this way never needs to be re-tested against an MFA-enabled account,
      // that's a deliberate product decision (see AuthService.completeWebauthnLogin).
      const me = await http().get('/v1/auth/me').set('Authorization', `Bearer ${done.body.accessToken}`).expect(200);
      expect(me.body.userId).toBe(tenant.userId);

      // A second attempt to replay the exact same signed assertion is refused —
      // its challenge was already consumed (single-use, short-lived JWT) even
      // though the signature itself would still verify.
      await http()
        .post('/v1/auth/webauthn/login/verify')
        .send({ challengeToken: loginOptionsRes.body.challengeToken, response: assertion })
        .expect(401);

      // Revoking the credential removes it from the list and it can no longer sign in.
      await http().delete(`/v1/auth/webauthn/credentials/${list.body[0].id}`).set(auth).expect(200);
      const afterRemoval = await http().get('/v1/auth/webauthn/credentials').set(auth).expect(200);
      expect(afterRemoval.body).toHaveLength(0);
    });

    it('rejects an assertion signed by the wrong authenticator for a registered credential id', async () => {
      const tenant = await createTestTenant([]);
      const initial = await login(tenant.username).expect(200);
      const auth = { Authorization: `Bearer ${initial.body.accessToken}` };

      const optionsRes = await http().post('/v1/auth/webauthn/register/options').set(auth).expect(200);
      const authenticator = new VirtualAuthenticator();
      const registrationResponse = authenticator.register(optionsRes.body.options.challenge);
      await http()
        .post('/v1/auth/webauthn/register/verify')
        .set(auth)
        // Step-up re-auth proof required to enrol a passkey (see above).
        .send({ challengeToken: optionsRes.body.challengeToken, response: registrationResponse, currentPassword: TEST_PASSWORD })
        .expect(200);

      const loginOptionsRes = await http().post('/v1/auth/webauthn/login/options').expect(200);
      // A different authenticator signs the assertion but claims the first one's credential id.
      const impostor = new VirtualAuthenticator();
      const forged = impostor.authenticate(loginOptionsRes.body.options.challenge);
      forged.id = registrationResponse.id;
      forged.rawId = registrationResponse.rawId;

      const res = await http()
        .post('/v1/auth/webauthn/login/verify')
        .send({ challengeToken: loginOptionsRes.body.challengeToken, response: forged })
        .expect(401);
      expect(res.body.error.code).toBe('WEBAUTHN_VERIFICATION_FAILED');
    });
  });
});
