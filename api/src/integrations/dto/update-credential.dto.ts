import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateCredentialDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  /**
   * Present only to rotate the secret — the client never pre-fills this on
   * edit (there's nothing to pre-fill it with; the vault never returns the
   * plaintext or ciphertext). Omit to leave the stored secret unchanged.
   */
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  secretValue?: string;
}
