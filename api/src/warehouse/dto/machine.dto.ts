import {
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

const MACHINE_STATUSES = ['OPERATIONAL', 'NEEDS_ATTENTION', 'DOWN'] as const;
const LOG_KINDS = ['SERVICE', 'REPAIR', 'READING', 'NOTE'] as const;

export class CreateMachineDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  machineType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  serialNumber?: string;

  @IsOptional()
  @IsIn(MACHINE_STATUSES)
  status?: (typeof MACHINE_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  lastServiceAt?: string;

  @IsOptional()
  @IsString()
  nextServiceDueAt?: string;
}

export class UpdateMachineDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  machineType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  serialNumber?: string;

  @IsOptional()
  @IsIn(MACHINE_STATUSES)
  status?: (typeof MACHINE_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  lastServiceAt?: string;

  @IsOptional()
  @IsString()
  nextServiceDueAt?: string;
}

export class ListMachinesDto extends ListQueryDto {
  @IsOptional()
  @IsIn(MACHINE_STATUSES)
  status?: (typeof MACHINE_STATUSES)[number];

  // `search` is inherited from ListQueryDto.
}

export class CreateMachineLogDto {
  @IsIn(LOG_KINDS)
  kind!: (typeof LOG_KINDS)[number];

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  summary!: string;

  @IsOptional()
  @IsNumber()
  meterValue?: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  meterUnit?: string;

  @IsOptional()
  @IsString()
  occurredAt?: string;
}
