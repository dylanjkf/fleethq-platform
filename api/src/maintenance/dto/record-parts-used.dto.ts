import { IsInt, IsUUID, Min } from 'class-validator';

export class RecordPartsUsedDto {
  @IsUUID()
  partId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}
