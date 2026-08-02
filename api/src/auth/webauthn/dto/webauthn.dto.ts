import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

/**
 * `response` is the browser's `PublicKeyCredential` JSON, as produced by
 * `@simplewebauthn/browser`'s `startRegistration`/`startAuthentication` — a
 * deeply nested, provider-defined shape not worth hand-writing per-field
 * validators for. `@IsObject()` only guards the request body's outer shape;
 * the real verification is the cryptographic signature check in
 * WebauthnService, which rejects anything malformed or forged on its own.
 */
export class WebauthnRegisterVerifyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  challengeToken!: string;

  @IsObject()
  response!: RegistrationResponseJSON;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceLabel?: string;

  /**
   * Step-up re-authentication proof. Adding a passkey is as sensitive as
   * changing the password or toggling MFA, so — exactly like those flows — the
   * caller must re-prove a live credential rather than rely on a possibly
   * 12h/30-day-old access token. Supply EITHER the current password OR a
   * current MFA code (TOTP or a backup code, for accounts with MFA enabled);
   * the server rejects the registration if neither is valid.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(20)
  mfaCode?: string;
}

export class WebauthnAuthenticateVerifyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  challengeToken!: string;

  @IsObject()
  response!: AuthenticationResponseJSON;
}
