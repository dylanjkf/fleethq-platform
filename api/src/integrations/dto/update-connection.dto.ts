import { IntegrationConnectorType, IntegrationDirection } from '@prisma/client';
import { IsBoolean, IsEnum, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { ALLOWED_TARGET_ENTITIES, TargetEntity } from './allowed-target-entities';

export class UpdateConnectionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsEnum(IntegrationConnectorType)
  connectorType?: IntegrationConnectorType;

  @IsOptional()
  @IsEnum(IntegrationDirection)
  direction?: IntegrationDirection;

  @IsOptional()
  @IsIn(ALLOWED_TARGET_ENTITIES)
  targetEntity?: TargetEntity;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsUUID()
  credentialId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  scheduleCron?: string | null;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
