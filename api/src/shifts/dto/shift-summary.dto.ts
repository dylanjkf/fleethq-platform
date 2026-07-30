import { IsDateString, IsOptional } from 'class-validator';

export class ShiftSummaryDto {
  /** Defaults to today (server-local date) when omitted. */
  @IsOptional()
  @IsDateString()
  date?: string;
}
