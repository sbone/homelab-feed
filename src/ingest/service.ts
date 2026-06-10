import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { events, rawEvents, resources, sourceCursors, sources, type SourceRow } from "../db/schema.js";
import type { IngestMethod, NormalizedEvent, ResourceDraft, RuntimeSource } from "../types.js";
import { canonicalResourceKey } from "../adapters/helpers.js";
import { hashPayload } from "../utils/hash.js";

export interface IngestRequest {
  source: RuntimeSource;
  sourceRow: SourceRow;
  adapter: string;
  ingestMethod: IngestMethod;
  payload: unknown;
  normalizedEvents: NormalizedEvent[];
}

export interface IngestResult {
  rawEventId?: string;
  insertedEvents: number;
}

export async function ingestNormalized(db: Database, request: IngestRequest): Promise<IngestResult> {
  const rawHash = hashPayload({
    adapter: request.adapter,
    ingestMethod: request.ingestMethod,
    payload: request.payload,
  });
  const occurredAt = firstOccurredAt(request.normalizedEvents);
  const [raw] = await db
    .insert(rawEvents)
    .values({
      sourceId: request.sourceRow.id,
      sourceKey: request.source.key,
      adapter: request.adapter,
      ingestMethod: request.ingestMethod,
      payloadHash: rawHash,
      payload: request.payload,
      eventTimestamp: occurredAt,
    })
    .onConflictDoNothing()
    .returning({ id: rawEvents.id });

  let insertedEvents = 0;
  for (const normalized of request.normalizedEvents) {
    const resourceId = normalized.resource
      ? await upsertResource(db, normalized.resource, request.source.key)
      : undefined;
    const [event] = await db
      .insert(events)
      .values({
        rawEventId: raw?.id,
        sourceId: request.sourceRow.id,
        resourceId,
        occurredAt: normalized.occurredAt ?? new Date(),
        severity: normalized.severity,
        eventType: normalized.eventType,
        title: normalized.title,
        message: normalized.message,
        dedupeKey: normalized.dedupeKey,
        correlationKey: normalized.correlationKey,
        visibility: normalized.visibility ?? "default",
        attributes: normalized.attributes ?? {},
      })
      .onConflictDoNothing()
      .returning({ id: events.id });

    if (event) {
      insertedEvents += 1;
    } else {
      await db
        .update(events)
        .set({
          ...(raw?.id ? { rawEventId: raw.id } : {}),
          resourceId,
          occurredAt: normalized.occurredAt ?? new Date(),
          severity: normalized.severity,
          eventType: normalized.eventType,
          title: normalized.title,
          message: normalized.message,
          correlationKey: normalized.correlationKey,
          visibility: normalized.visibility ?? "default",
          attributes: normalized.attributes ?? {},
        })
        .where(and(eq(events.sourceId, request.sourceRow.id), eq(events.dedupeKey, normalized.dedupeKey)));
    }
  }

  return { rawEventId: raw?.id, insertedEvents };
}

export async function upsertResource(
  db: Database,
  resource: ResourceDraft,
  sourceKey: string,
): Promise<string> {
  const canonicalKey = canonicalResourceKey(resource, sourceKey);
  const [row] = await db
    .insert(resources)
    .values({
      resourceType: resource.resourceType,
      canonicalKey,
      title: resource.title,
      subtitle: resource.subtitle,
      externalIds: compactJson(resource.externalIds),
      appRefs: compactJson(resource.appRefs),
    })
    .onConflictDoUpdate({
      target: resources.canonicalKey,
      set: {
        title: resource.title,
        subtitle: resource.subtitle,
        externalIds: sql`${resources.externalIds} || ${compactJson(resource.externalIds)}::jsonb`,
        appRefs: sql`${resources.appRefs} || ${compactJson(resource.appRefs)}::jsonb`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: resources.id });

  return row.id;
}

export interface EventQuery {
  app?: string;
  sourceKey?: string;
  severity?: string;
  eventType?: string;
  resource?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
  includeLowValue: boolean;
}

export async function queryEvents(db: Database, query: EventQuery) {
  const filters = [];
  if (!query.includeLowValue) {
    filters.push(eq(events.visibility, "default"));
  }
  if (query.severity) {
    filters.push(eq(events.severity, query.severity));
  }
  if (query.eventType) {
    filters.push(eq(events.eventType, query.eventType));
  }
  if (query.from) {
    filters.push(gte(events.occurredAt, query.from));
  }
  if (query.to) {
    filters.push(lte(events.occurredAt, query.to));
  }
  if (query.cursor) {
    filters.push(lte(events.occurredAt, new Date(query.cursor)));
  }
  if (query.app) {
    filters.push(eq(sources.app, query.app));
  }
  if (query.sourceKey) {
    filters.push(eq(sources.key, query.sourceKey));
  }
  if (query.resource) {
    filters.push(
      sql`(${resources.canonicalKey} = ${query.resource} or ${resources.title} ilike ${`%${query.resource}%`})`,
    );
  }

  return db
    .select({
      id: events.id,
      occurredAt: events.occurredAt,
      severity: events.severity,
      eventType: events.eventType,
      title: events.title,
      message: events.message,
      dedupeKey: events.dedupeKey,
      correlationKey: events.correlationKey,
      visibility: events.visibility,
      attributes: events.attributes,
      source: {
        key: sources.key,
        app: sources.app,
        name: sources.name,
      },
      resource: {
        id: resources.id,
        resourceType: resources.resourceType,
        canonicalKey: resources.canonicalKey,
        title: resources.title,
        subtitle: resources.subtitle,
        externalIds: resources.externalIds,
        appRefs: resources.appRefs,
      },
    })
    .from(events)
    .innerJoin(sources, eq(events.sourceId, sources.id))
    .leftJoin(resources, eq(events.resourceId, resources.id))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(events.occurredAt), desc(events.createdAt))
    .limit(query.limit);
}

export async function listResources(db: Database, search: string | undefined, limit: number) {
  const filters = search
    ? sql`(${resources.canonicalKey} ilike ${`%${search}%`} or ${resources.title} ilike ${`%${search}%`})`
    : undefined;

  return db
    .select()
    .from(resources)
    .where(filters)
    .orderBy(desc(resources.updatedAt))
    .limit(limit);
}

export async function getCursor(
  db: Database,
  sourceId: string,
  cursorKey: string,
): Promise<Record<string, unknown> | undefined> {
  const [row] = await db
    .select()
    .from(sourceCursors)
    .where(and(eq(sourceCursors.sourceId, sourceId), eq(sourceCursors.cursorKey, cursorKey)))
    .limit(1);
  return row?.cursorValue;
}

export async function setCursor(
  db: Database,
  sourceId: string,
  cursorKey: string,
  cursorValue: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(sourceCursors)
    .values({ sourceId, cursorKey, cursorValue })
    .onConflictDoUpdate({
      target: [sourceCursors.sourceId, sourceCursors.cursorKey],
      set: { cursorValue, updatedAt: new Date() },
    });
}

function firstOccurredAt(eventsToInsert: NormalizedEvent[]): Date | undefined {
  return eventsToInsert.find((event) => event.occurredAt)?.occurredAt;
}

function compactJson(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, inner]) => inner !== undefined && inner !== null && inner !== ""),
  );
}
