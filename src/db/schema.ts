import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    app: text("app").notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url"),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    secretRefs: jsonb("secret_refs").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyUnique: uniqueIndex("sources_key_unique").on(table.key),
    appIdx: index("sources_app_idx").on(table.app),
  }),
);

export const resources = pgTable(
  "resources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    resourceType: text("resource_type").notNull(),
    canonicalKey: text("canonical_key").notNull(),
    title: text("title"),
    subtitle: text("subtitle"),
    externalIds: jsonb("external_ids").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    appRefs: jsonb("app_refs").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    canonicalKeyUnique: uniqueIndex("resources_canonical_key_unique").on(table.canonicalKey),
    typeIdx: index("resources_type_idx").on(table.resourceType),
  }),
);

export const sourceCursors = pgTable(
  "source_cursors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    cursorKey: text("cursor_key").notNull(),
    cursorValue: jsonb("cursor_value").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceCursorUnique: uniqueIndex("source_cursors_source_key_unique").on(table.sourceId, table.cursorKey),
  }),
);

export const rawEvents = pgTable(
  "raw_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    adapter: text("adapter").notNull(),
    ingestMethod: text("ingest_method").notNull(),
    payloadHash: text("payload_hash").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    eventTimestamp: timestamp("event_timestamp", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    rawEventUnique: uniqueIndex("raw_events_source_hash_unique").on(table.sourceId, table.payloadHash),
    sourceReceivedIdx: index("raw_events_source_received_idx").on(table.sourceId, table.receivedAt),
  }),
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    rawEventId: uuid("raw_event_id").references(() => rawEvents.id, { onDelete: "set null" }),
    sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    resourceId: uuid("resource_id").references(() => resources.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    severity: text("severity").notNull(),
    eventType: text("event_type").notNull(),
    title: text("title").notNull(),
    message: text("message"),
    dedupeKey: text("dedupe_key").notNull(),
    correlationKey: text("correlation_key"),
    visibility: text("visibility").notNull().default("default"),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    eventDedupeUnique: uniqueIndex("events_source_dedupe_unique").on(table.sourceId, table.dedupeKey),
    occurredIdx: index("events_occurred_idx").on(table.occurredAt),
    sourceOccurredIdx: index("events_source_occurred_idx").on(table.sourceId, table.occurredAt),
    resourceOccurredIdx: index("events_resource_occurred_idx").on(table.resourceId, table.occurredAt),
    severityIdx: index("events_severity_idx").on(table.severity),
    eventTypeIdx: index("events_event_type_idx").on(table.eventType),
  }),
);

export const sourceRelations = relations(sources, ({ many }) => ({
  rawEvents: many(rawEvents),
  events: many(events),
  cursors: many(sourceCursors),
}));

export const resourceRelations = relations(resources, ({ many }) => ({
  events: many(events),
}));

export const rawEventRelations = relations(rawEvents, ({ one, many }) => ({
  source: one(sources, { fields: [rawEvents.sourceId], references: [sources.id] }),
  events: many(events),
}));

export const eventRelations = relations(events, ({ one }) => ({
  source: one(sources, { fields: [events.sourceId], references: [sources.id] }),
  resource: one(resources, { fields: [events.resourceId], references: [resources.id] }),
  rawEvent: one(rawEvents, { fields: [events.rawEventId], references: [rawEvents.id] }),
}));

export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;
export type ResourceRow = typeof resources.$inferSelect;
export type EventRow = typeof events.$inferSelect;
