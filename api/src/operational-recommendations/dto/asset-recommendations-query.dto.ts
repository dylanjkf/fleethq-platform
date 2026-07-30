import { IsOptional, IsUUID } from 'class-validator';

export class AssetRecommendationsQueryDto {
  /** The job being assigned, if any — so its own current asset isn't penalized as "already busy" against itself. */
  @IsOptional()
  @IsUUID()
  excludeJobId?: string;
}
