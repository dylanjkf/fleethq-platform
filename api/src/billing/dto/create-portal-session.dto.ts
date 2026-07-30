import { IsUrl } from 'class-validator';

export class CreatePortalSessionDto {
  @IsUrl({ require_tld: false })
  returnUrl!: string;
}
