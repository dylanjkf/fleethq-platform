import { IntegrationWebhookDirection } from '@prisma/client';
import { IsBoolean, IsEnum, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateWebhookDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsEnum(IntegrationWebhookDirection)
  direction!: IntegrationWebhookDirection;

  @IsOptional()
  @IsUUID()
  connectionId?: string;

  /**
   * Required for OUTGOING (where FleetHQ posts to). Not `@IsUrl()` — that
   * would reject a bare `http://localhost:PORT` target, which is exactly what
   * local dev/test and many on-prem receivers use.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  targetUrl?: string;

  @IsOptional()
  @IsUUID()
  secretCredentialId?: string;

  @IsOptional()
  @IsObject()
  headerTemplate?: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}

export class UpdateWebhookDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  targetUrl?: string | null;

  @IsOptional()
  @IsUUID()
  secretCredentialId?: string | null;

  @IsOptional()
  @IsObject()
  headerTemplate?: Record<string, string> | null;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
