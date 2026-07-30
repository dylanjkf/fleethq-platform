import { IsIn, IsUUID } from 'class-validator';
import { TimelineEntityType } from '@prisma/client';
import { ListQueryDto } from '../../common/dto/list-query.dto';

const ENTITY_TYPES = Object.values(TimelineEntityType);

export class ListTimelineDto extends ListQueryDto {
  @IsIn(ENTITY_TYPES)
  entityType!: TimelineEntityType;

  @IsUUID()
  entityId!: string;
}
