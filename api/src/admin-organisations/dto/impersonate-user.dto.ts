import { IsUUID } from 'class-validator';

export class ImpersonateUserDto {
  @IsUUID()
  userId!: string;
}
