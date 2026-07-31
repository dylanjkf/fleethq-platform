import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { IsAbn } from '../../common/validators/is-abn.validator';

export class UpdateCompanyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  // No `jurisdiction` field yet — "AU" is the only implemented jurisdiction
  // (08-Compliance/Jurisdiction_Model.md), so there's nothing meaningful to
  // switch it to at the API layer today.

  /** 01-Product/Support_Help_Pathway.md's operator fallback contact. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  supportPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  supportNotes?: string;

  // Auth/Billing Platform Phase 4 (registration depth) — editable after signup, same as at intake.

  @IsOptional()
  @IsAbn()
  abn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  industry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  fleetSizeEstimate?: number;
}
