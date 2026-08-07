import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ChangeQuantityDto {
  /** The new number of paid asset slots (the hard cap). Must be >= current live asset usage. */
  @IsInt()
  @Min(1)
  @Max(100_000)
  quantity!: number;

  /** Optional free-text note recorded on the admin audit trail (why the change was made). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
