import { ListQueryDto } from '../../common/dto/list-query.dto';

/**
 * The staff-account list reuses the app-wide pagination shape. `search`
 * (inherited) matches username / email / full name; `includeArchived`
 * (inherited) surfaces deactivated accounts, which are hidden by default so
 * the roster shows only who can currently log in.
 */
export class ListAdminUsersDto extends ListQueryDto {}
