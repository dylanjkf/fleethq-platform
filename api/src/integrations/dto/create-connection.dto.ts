import { IntegrationConnectorType, IntegrationDirection } from '@prisma/client';
import { IsBoolean, IsEnum, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { ALLOWED_TARGET_ENTITIES, TargetEntity } from './allowed-target-entities';

export class CreateConnectionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsEnum(IntegrationConnectorType)
  connectorType!: IntegrationConnectorType;

  @IsEnum(IntegrationDirection)
  direction!: IntegrationDirection;

  @IsIn(ALLOWED_TARGET_ENTITIES)
  targetEntity!: TargetEntity;

  /** Connector-specific, non-secret config — e.g. REST url/apiKeyHeader/responseArrayPath. */
  @IsObject()
  config!: Record<string, unknown>;

  @IsOptional()
  @IsUUID()
  credentialId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  scheduleCron?: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
