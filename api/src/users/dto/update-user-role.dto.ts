import { IsUUID } from 'class-validator';

export class UpdateUserRoleDto {
  @IsUUID()
  roleId!: string;
}
