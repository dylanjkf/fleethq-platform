import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ALLOWED_CONTENT_TYPES } from '../../attachments/dto/upload-attachment.dto';

export class CreateDocumentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename!: string;

  @IsIn(ALLOWED_CONTENT_TYPES)
  contentType!: string;

  /** The file's bytes, base64-encoded (PDF or image; 8 MB max). */
  @IsString()
  @MinLength(1)
  dataBase64!: string;
}
