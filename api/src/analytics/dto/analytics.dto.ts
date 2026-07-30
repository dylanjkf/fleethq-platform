import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** The metrics whose live dashboard percentage can be manually overridden. */
export const OVERRIDABLE_METRICS = ['utilisation', 'compliance_current', 'prestart'] as const;
export type OverridableMetric = (typeof OVERRIDABLE_METRICS)[number];

export class UpdateAnalyticsSettingsDto {
  @IsOptional() @IsInt() @Min(0) @Max(100) utilisationTarget?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) complianceTarget?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) goodThreshold?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) warnThreshold?: number;
}

export class SetOverrideDto {
  @IsInt() @Min(0) @Max(100) value!: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class SetExclusionDto {
  @IsBoolean() excluded!: boolean;
}
