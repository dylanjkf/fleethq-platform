import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type AttachmentContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

export class UploadAttachmentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename!: string;

  @IsIn(ALLOWED_CONTENT_TYPES)
  contentType!: AttachmentContentType;

  /** Base64 payload — accepts a raw base64 string or a `data:...;base64,` URL. */
  @IsString()
  @IsNotEmpty()
  dataBase64!: string;
}
