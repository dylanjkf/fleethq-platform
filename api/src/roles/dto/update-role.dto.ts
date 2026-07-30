import { ArrayUnique, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PERMISSIONS } from '../../common/permissions/permission-catalog';

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** When provided, replaces the role's entire permission set — not a merge/patch. */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(Object.values(PERMISSIONS), { each: true })
  permissionKeys?: string[];
}
