import { Injectable } from '@nestjs/common';
import { Prisma, TimelineActorType, TimelineEntityType } from '@prisma/client';
import { uuidv7 } from 'uuidv7';

export interface RecordTimelineEventInput {
  companyId: string;
  entityType: TimelineEntityType;
  entityId: string;
  eventType: string;
  summary: string;
  payload?: Record<string, unknown>;
  actorUserId?: string;
}

/**
 * The one place that writes to `timeline_events`. Every entity mutation in this
 * codebase goes through here — 00-Company/Core_Principles.md: "if a piece of
 * state changes, a timeline event records what changed, when, and by whom."
 * This is a service-layer discipline (per 11-Database/Data_Model.md: "Entity
 * state changes are always accompanied by a TimelineEvent — this is a
 * discipline enforced at the service layer, not left to be remembered
 * per-feature"), backed by the fact the runtime DB role has no UPDATE/DELETE
 * grant on this table, so even a bug here can't retroactively alter history.
 */
@Injectable()
export class TimelineService {
  async record(tx: Prisma.TransactionClient, input: RecordTimelineEventInput): Promise<void> {
    await tx.timelineEvent.create({
      data: {
        // Explicit UUIDv7 (time-ordered) rather than the schema's default
        // UUIDv4 — this is the highest-write-volume, longest-retention table
        // in the platform ("millions of timeline events... years of
        // history"), and a random v4 PK hurts B-tree insert locality now and
        // blocks range-based partitioning later (the PK carries no time
        // signal). See 02-Architecture/Scaling_And_Enterprise_Readiness.md.
        // No schema/migration change needed — the column stays a plain
        // Postgres `uuid`, only the generated value's shape changes.
        id: uuidv7(),
        companyId: input.companyId,
        entityType: input.entityType,
        entityId: input.entityId,
        eventType: input.eventType,
        summary: input.summary,
        payload: input.payload as Prisma.InputJsonValue | undefined,
        actorType: input.actorUserId ? TimelineActorType.USER : TimelineActorType.SYSTEM,
        actorUserId: input.actorUserId,
      },
    });
  }
}
