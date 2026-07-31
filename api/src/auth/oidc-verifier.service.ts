import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { OAuthProvider } from '@prisma/client';

export interface VerifiedIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
}

interface ProviderConfig {
  jwksUri: string;
  audience: string;
  issuerCheck: (iss: string) => boolean;
}

const TENANT_ISS_PATTERN = /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/;

/**
 * Verifies a third-party identity provider's OpenID Connect id_token —
 * signature (via the provider's own published JWKS, fetched and cached by
 * `jose`), audience, issuer, and required claims — for Auth/Billing Platform
 * Phase 2 social login (22-Auth-Billing-Platform/Overview.md). Real
 * cryptographic verification (RS256 against the IdP's rotating public keys),
 * not a client-supplied claim taken on faith.
 *
 * Config-gated, mirroring NotificationsModule's SES-vs-logging-channel
 * pattern: a provider is "enabled" purely by whether its client id env var is
 * set. With nothing configured, both providers are simply absent from
 * `GET /v1/auth/providers` and every /oauth/:provider endpoint refuses with
 * a clear "not configured" error — local dev/CI need zero OAuth setup.
 */
@Injectable()
export class OidcVerifierService {
  private readonly jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(private readonly config: ConfigService) {}

  isConfigured(provider: OAuthProvider): boolean {
    return provider === 'GOOGLE' ? !!this.config.get<string>('GOOGLE_OAUTH_CLIENT_ID') : !!this.config.get<string>('MICROSOFT_OAUTH_CLIENT_ID');
  }

  async verify(provider: OAuthProvider, idToken: string): Promise<VerifiedIdentity> {
    const cfg = provider === 'GOOGLE' ? this.googleConfig() : this.microsoftConfig();
    if (!cfg.audience) {
      throw new UnauthorizedException({ code: 'PROVIDER_NOT_CONFIGURED', message: `${provider} sign-in is not enabled.` });
    }

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(idToken, this.getJwks(cfg.jwksUri), { audience: cfg.audience });
      payload = result.payload;
    } catch {
      throw new UnauthorizedException({ code: 'INVALID_ID_TOKEN', message: 'Could not verify that sign-in token.' });
    }

    const iss = typeof payload.iss === 'string' ? payload.iss : '';
    if (!cfg.issuerCheck(iss)) {
      throw new UnauthorizedException({ code: 'INVALID_ID_TOKEN', message: 'Unexpected token issuer.' });
    }

    const subject = payload.sub;
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    if (!subject || !email) {
      throw new UnauthorizedException({ code: 'INVALID_ID_TOKEN', message: 'That sign-in token did not include an email address.' });
    }

    // Google explicitly asserts `email_verified`. Microsoft's v2 tokens carry
    // no such claim — a first-party `login.microsoftonline.com`-issued token
    // (already confirmed above) is treated as verified by construction.
    const emailVerifiedClaim = payload['email_verified'];
    const emailVerified = provider === 'MICROSOFT' || emailVerifiedClaim === true || emailVerifiedClaim === 'true';

    return { subject, email, emailVerified };
  }

  private googleConfig(): ProviderConfig {
    return {
      jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
      audience: this.config.get<string>('GOOGLE_OAUTH_CLIENT_ID', ''),
      issuerCheck: (iss) => iss === 'https://accounts.google.com' || iss === 'accounts.google.com',
    };
  }

  private microsoftConfig(): ProviderConfig {
    // Defaults to the multi-tenant "common" endpoint (personal + any work/school
    // account). A single-tenant deployment can pin MICROSOFT_OAUTH_TENANT_ID to
    // its own directory GUID for an exact issuer match instead of the pattern
    // check below.
    const tenant = this.config.get<string>('MICROSOFT_OAUTH_TENANT_ID', 'common');
    const fixedTenant = !['common', 'organizations', 'consumers'].includes(tenant);
    return {
      jwksUri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
      audience: this.config.get<string>('MICROSOFT_OAUTH_CLIENT_ID', ''),
      issuerCheck: (iss) => (fixedTenant ? iss === `https://login.microsoftonline.com/${tenant}/v2.0` : TENANT_ISS_PATTERN.test(iss)),
    };
  }

  private getJwks(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
    let jwks = this.jwksCache.get(jwksUri);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(jwksUri));
      this.jwksCache.set(jwksUri, jwks);
    }
    return jwks;
  }
}
