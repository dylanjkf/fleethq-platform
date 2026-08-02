import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

/**
 * A real support ticket almost always arrives as an email address, not a
 * company name or a raw user id — so this adds the cross-tenant "who is this
 * email?" lookup the organisation list can't do. Reuses the app-wide
 * pagination shape (page/pageSize) so the surface matches every other admin
 * list endpoint.
 */
export class SearchCustomerUsersDto extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;

  /** Normalised email filter (trimmed, lower-cased), or undefined when blank. */
  get emailTerm(): string | undefined {
    const trimmed = this.email?.trim().toLowerCase();
    return trimmed ? trimmed : undefined;
  }
}
