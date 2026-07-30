import { ComplianceDocumentType } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateComplianceDocumentDto {
  @IsOptional()
  @IsEnum(ComplianceDocumentType)
  documentType?: ComplianceDocumentType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  documentNumber?: string;

  @IsOptional()
  @IsDateString()
  issuedAt?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  /** Replaces any existing file attachment, base64 (raw or data URL). */
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
