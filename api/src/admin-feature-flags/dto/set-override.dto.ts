import { IsBoolean } from 'class-validator';

export class SetOverrideDto {
  @IsBoolean()
  enabled!: boolean;
}
