import { IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * The optional structured specs an AttachedUnit can carry, shared by the create
 * and update DTOs so the validators are declared once. Deliberately the same
 * fields and limits Asset uses (`make`/`model`/`year`/`vin`/`registration` +
 * a free-form `customFields`) — a trailer's identity data is the same shape as a
 * prime mover's, and one vocabulary is easier to maintain than two.
 *
 * Odometer is intentionally absent: an attached unit has no engine hours or
 * distance of its own in this model; usage is derived from the asset it's hitched
 * to via the PAIRED_WITH relationship.
 */
export class AttachedUnitSpecsDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  make?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2100)
  year?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  vin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  registration?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  /** Free-form company-defined fields (key → value), never schema-migrated. */
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}
