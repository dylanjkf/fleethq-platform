import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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
}
