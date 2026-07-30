import { IsUUID } from 'class-validator';

export class HitchAttachedUnitDto {
  @IsUUID()
  assetId!: string;
}
