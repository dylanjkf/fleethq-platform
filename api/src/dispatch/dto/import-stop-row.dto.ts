import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * One manifest row for stop import. Deliberately has no `@IsNotEmpty`/required
 * field — a row is valid if it carries EITHER `label` OR `customerName`
 * (checked in JobsService, since that's a cross-field rule class-validator
 * can't express with per-property decorators alone).
 */
export class ImportStopRowDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  customerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactName?: string;
}
