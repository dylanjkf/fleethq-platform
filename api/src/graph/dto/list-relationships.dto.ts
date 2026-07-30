import { IsIn, IsUUID } from 'class-validator';
import { TimelineEntityType } from '@prisma/client';

const ENTITY_TYPES = Object.values(TimelineEntityType);

export class ListRelationshipsDto {
  @IsIn(ENTITY_TYPES)
  entityType!: TimelineEntityType;

  @IsUUID()
  entityId!: string;
}
