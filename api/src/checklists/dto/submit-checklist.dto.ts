import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { ChecklistItemDto } from './checklist-item.dto';
import { ChecklistAnswerDto } from './checklist-answer.dto';

export class SubmitChecklistDto {
  /**
   * Client-generated submission id (uuid). Included so an offline outbox replay
   * after a flaky reconnect is idempotent — re-submitting the same id returns the
   * already-recorded checklist instead of creating a duplicate. Optional: an
   * online submit may omit it and let the server assign one.
   */
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsUUID()
  templateId!: string;

  @IsInt()
  @Min(1)
  templateVersion!: number;

  /**
   * The exact items the operator saw and answered. Sent by the client (which may
   * have been offline against an older cached template version) so the recorded
   * checklist is a faithful account independent of any later office-side edit.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ChecklistItemDto)
  templateSnapshot!: ChecklistItemDto[];

  @IsUUID()
  assetId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ChecklistAnswerDto)
  answers!: ChecklistAnswerDto[];

  /** When the operator opened the checklist (for the recorded start→submit span). */
  @IsOptional()
  @IsDateString()
  startedAt?: string;
}
