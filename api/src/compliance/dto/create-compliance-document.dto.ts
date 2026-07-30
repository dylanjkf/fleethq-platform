import { ComplianceDocumentType } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateComplianceDocumentDto {
  /** Exactly one of assetId/operatorId must be given — the service validates this. */
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @IsOptional()
  @IsUUID()
  operatorId?: string;

  @IsEnum(ComplianceDocumentType)
  documentType!: ComplianceDocumentType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  documentNumber?: string;

  @IsOptional()
  @IsDateString()
  issuedAt?: string;

  @IsDateString()
  expiresAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  /** Optional scan/photo of the document, base64 (raw or data URL). Stored as an Attachment. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  filePhotoBase64?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  filePhotoContentType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  filePhotoFilename?: string;
}
