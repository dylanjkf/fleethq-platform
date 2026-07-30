import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AttachedUnitSpecsDto } from './attached-unit-specs.dto';

export class CreateAttachedUnitDto extends AttachedUnitSpecsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  externalReference?: string;
}
