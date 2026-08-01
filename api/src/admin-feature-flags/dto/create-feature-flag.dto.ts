import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateFeatureFlagDto {
  /** Stable machine key a route's `@RequireFeatureFlag(...)` refers to — lowercase, underscore-separated. */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/^[a-z][a-z0-9_]*$/, { message: 'key must be lowercase, alphanumeric, underscore-separated, starting with a letter' })
  key!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  description!: string;

  /** Default for every company that has no override. Defaults to true (opt-out, not opt-in). */
  @IsOptional()
  @IsBoolean()
  globalEnabled?: boolean;
}
