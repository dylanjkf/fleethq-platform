import { IsUUID } from 'class-validator';

/** Reassign a staff member to a different admin role. Role changes take effect
 *  immediately — AdminPermissionGuard resolves permissions fresh per request,
 *  so no re-login is needed. */
export class UpdateAdminUserRoleDto {
  @IsUUID()
  roleId!: string;
}
