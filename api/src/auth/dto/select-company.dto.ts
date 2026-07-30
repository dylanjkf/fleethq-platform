import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class SelectCompanyDto {
  // A signed pre-auth JWT — bounded so an oversized string can't be used to
  // bloat logs or waste verification work on an unauthenticated endpoint.
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  preAuthToken!: string;

  @IsUUID()
  companyId!: string;
}
