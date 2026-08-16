import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * `cancel_for_cause` release (Part 2). A required reason is captured for the
 * audit trail — releasing a company from the 12-month minimum term early must
 * always be explainable after the fact (company shutting down, dispute,
 * regulator order, etc.).
 */
export class ReleaseContractDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}
