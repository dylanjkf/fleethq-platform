import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { ListQueryDto } from '../../common/dto/list-query.dto';

// Extends the shared pagination DTO so the documented page/pageSize params are
// accepted here too (previously a client sending them got a hard 400), and so
// the shift history — which grows unbounded with fleet activity — is read one
// bounded page at a time instead of returning the entire table.
export class ListShiftsDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  operatorId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
