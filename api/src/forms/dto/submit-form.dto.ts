import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsUUID, Min, ValidateNested } from 'class-validator';
import { FormFieldDto } from './form-field.dto';
import { FormAnswerDto } from './form-answer.dto';

export class SubmitFormDto {
  /**
   * Client-generated submission id (uuid). Same idempotent-replay reasoning as
   * `SubmitChecklistDto.id` — an offline outbox retry after a lost response
   * returns the already-recorded submission instead of creating a duplicate.
   */
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsUUID()
  templateId!: string;

  @IsInt()
  @Min(1)
  templateVersion!: number;

  /** The exact fields the user was shown — sent by the client so the record is a faithful account independent of any later office-side edit. */
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => FormFieldDto)
  templateSnapshot!: FormFieldDto[];

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => FormAnswerDto)
  answers!: FormAnswerDto[];
}
