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
}

export class WebauthnAuthenticateVerifyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  challengeToken!: string;

  @IsObject()
  response!: AuthenticationResponseJSON;
}
