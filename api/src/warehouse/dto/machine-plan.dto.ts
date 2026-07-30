import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateMachinePlanDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label!: string;

  @IsInt()
  @Min(1)
  @Max(3650)
  intervalDays!: number;

  @IsOptional()
  @IsString()
  lastServiceAt?: string;
}

export class UpdateMachinePlanDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) label?: string;
  @IsOptional() @IsInt() @Min(1) @Max(3650) intervalDays?: number;
  @IsOptional() @IsString() lastServiceAt?: string;
}

/** Copy one machine's active schedule to other machines. */
export class CopyMachineScheduleDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  @Type(() => String)
  targetMachineIds!: string[];
}
