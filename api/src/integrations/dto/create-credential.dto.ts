import { IntegrationAuthType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateCredentialDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsEnum(IntegrationAuthType)
  authType!: IntegrationAuthType;

  /**
   * The raw secret — an API key, a bearer token, "username:password" for
   * BASIC_AUTH, or a webhook signing secret. Required unless authType is
   * NONE. Never returned by any list/get response once stored.
   */
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  secretValue?: string;
}
