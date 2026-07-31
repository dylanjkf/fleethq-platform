import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server';
import { SystemPrismaService } from '../../prisma/system-prisma.service';

/** Self-contained, short-lived challenge — the same "no server-side session
 *  state" pattern PreAuthJwtPayload/MfaChallengePayload already use. `sub` is
 *  present only for a registration ceremony (it's tied to the enrolling
 *  account); a login ceremony is usernameless/discoverable-credential, so it
 *  has none. */
interface WebauthnChallengePayload {
  sub?: string;
  challenge: string;
  purpose: 'register' | 'authenticate';
}

const CHALLENGE_EXPIRES_IN = '2m';

export interface WebauthnCredentialSummary {
  id: string;
  deviceLabel: string | null;
  createdAt: Date;
  lastUsedAt: Date;
}

/**
 * WebAuthn/passkey registration and (usernameless) authentication, per
 * Auth/Billing Platform Phase 2 (22-Auth-Billing-Platform/Overview.md).
 * Cryptographic verification is entirely delegated to @simplewebauthn/server
 * — this service only owns the challenge lifecycle and credential storage.
 */
@Injectable()
export class WebauthnService {
  constructor(
    private readonly systemPrisma: SystemPrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private rpID(): string {
    const configured = this.config.get<string>('WEBAUTHN_RP_ID');
    return configured || new URL(this.origin()).hostname;
  }

  private rpName(): string {
    return this.config.get<string>('WEBAUTHN_RP_NAME', 'FleetOS');
  }

  private origin(): string {
    return this.config.get<string>('APP_BASE_URL', 'http://localhost:5173').replace(/\/$/, '');
  }

  async generateRegistrationOptionsFor(
    userId: string,
    username: string,
    fullName: string,
  ): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeToken: string }> {
    const existing = await this.systemPrisma.webauthnCredential.findMany({
      where: { userId },
      select: { credentialId: true, transports: true },
    });

    const options = await generateRegistrationOptions({
      rpName: this.rpName(),
      rpID: this.rpID(),
      userName: username,
      // A UUID's 16 raw bytes — the spec calls for an opaque byte identifier,
      // not the string form.
      userID: new Uint8Array(Buffer.from(userId.replace(/-/g, ''), 'hex')),
      userDisplayName: fullName,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        transports: c.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });

    const payload: WebauthnChallengePayload = { sub: userId, challenge: options.challenge, purpose: 'register' };
    return { options, challengeToken: this.jwt.sign(payload, { expiresIn: CHALLENGE_EXPIRES_IN }) };
  }

  async verifyRegistration(userId: string, challengeToken: string, response: RegistrationResponseJSON, deviceLabel?: string): Promise<void> {
    const payload = this.consumeChallenge(challengeToken, 'register');
    if (payload.sub !== userId) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'This passkey challenge is not valid for this account.' });
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: payload.challenge,
        expectedOrigin: this.origin(),
        expectedRPID: this.rpID(),
      });
    } catch {
      throw new UnauthorizedException({ code: 'WEBAUTHN_VERIFICATION_FAILED', message: 'Could not verify that passkey.' });
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new UnauthorizedException({ code: 'WEBAUTHN_VERIFICATION_FAILED', message: 'Could not verify that passkey.' });
    }

    const { credential } = verification.registrationInfo;
    await this.systemPrisma.webauthnCredential.create({
      data: {
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        signCount: BigInt(credential.counter),
        transports: credential.transports ?? [],
        deviceLabel: deviceLabel ?? null,
      },
    });
  }

  /** Usernameless (discoverable-credential) login — no identifier needed up front. */
  async generateAuthenticationOptionsForLogin(): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeToken: string }> {
    const options = await generateAuthenticationOptions({ rpID: this.rpID(), userVerification: 'preferred' });
    const payload: WebauthnChallengePayload = { challenge: options.challenge, purpose: 'authenticate' };
    return { options, challengeToken: this.jwt.sign(payload, { expiresIn: CHALLENGE_EXPIRES_IN }) };
  }

  /** Verifies the assertion and returns the userId it authenticated for, or null if it doesn't verify. */
  async verifyAuthentication(challengeToken: string, response: AuthenticationResponseJSON): Promise<string | null> {
    const payload = this.consumeChallenge(challengeToken, 'authenticate');

    const stored = await this.systemPrisma.webauthnCredential.findUnique({ where: { credentialId: response.id } });
    if (!stored) return null;

    const credential: WebAuthnCredential = {
      id: stored.credentialId,
      publicKey: new Uint8Array(stored.publicKey),
      counter: Number(stored.signCount),
      transports: stored.transports as AuthenticatorTransportFuture[],
    };

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: payload.challenge,
        expectedOrigin: this.origin(),
        expectedRPID: this.rpID(),
        credential,
      });
    } catch {
      return null;
    }
    if (!verification.verified) return null;

    // The authenticator's own replay counter must strictly increase between
    // uses; a cloned authenticator would report a stale or repeated value.
    // Persisted regardless of the check outcome isn't safe, so this update
    // only runs once verification has already succeeded above.
    await this.systemPrisma.webauthnCredential.update({
      where: { id: stored.id },
      data: { signCount: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() },
    });
    return stored.userId;
  }

  async listCredentials(userId: string): Promise<WebauthnCredentialSummary[]> {
    const rows = await this.systemPrisma.webauthnCredential.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => ({ id: r.id, deviceLabel: r.deviceLabel, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt }));
  }

  async removeCredential(userId: string, id: string): Promise<void> {
    await this.systemPrisma.webauthnCredential.deleteMany({ where: { id, userId } });
  }

  private consumeChallenge(token: string, purpose: WebauthnChallengePayload['purpose']): WebauthnChallengePayload {
    let payload: WebauthnChallengePayload;
    try {
      payload = this.jwt.verify<WebauthnChallengePayload>(token);
    } catch {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'This passkey challenge has expired. Please try again.' });
    }
    if (payload.purpose !== purpose) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Invalid passkey challenge.' });
    }
    return payload;
  }
}
