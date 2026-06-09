CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "app" text NOT NULL,
  "name" text NOT NULL,
  "base_url" text,
  "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "secret_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sources_key_unique" ON "sources" ("key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sources_app_idx" ON "sources" ("app");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "resource_type" text NOT NULL,
  "canonical_key" text NOT NULL,
  "title" text,
  "subtitle" text,
  "external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "app_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resources_canonical_key_unique" ON "resources" ("canonical_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resources_type_idx" ON "resources" ("resource_type");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_cursors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "sources"("id") ON DELETE cascade,
  "cursor_key" text NOT NULL,
  "cursor_value" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "source_cursors_source_key_unique" ON "source_cursors" ("source_id", "cursor_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "sources"("id") ON DELETE cascade,
  "source_key" text NOT NULL,
  "adapter" text NOT NULL,
  "ingest_method" text NOT NULL,
  "payload_hash" text NOT NULL,
  "payload" jsonb NOT NULL,
  "event_timestamp" timestamp with time zone,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "raw_events_source_hash_unique" ON "raw_events" ("source_id", "payload_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "raw_events_source_received_idx" ON "raw_events" ("source_id", "received_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "raw_event_id" uuid REFERENCES "raw_events"("id") ON DELETE set null,
  "source_id" uuid NOT NULL REFERENCES "sources"("id") ON DELETE cascade,
  "resource_id" uuid REFERENCES "resources"("id") ON DELETE set null,
  "occurred_at" timestamp with time zone NOT NULL,
  "severity" text NOT NULL,
  "event_type" text NOT NULL,
  "title" text NOT NULL,
  "message" text,
  "dedupe_key" text NOT NULL,
  "correlation_key" text,
  "visibility" text DEFAULT 'default' NOT NULL,
  "attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_source_dedupe_unique" ON "events" ("source_id", "dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_occurred_idx" ON "events" ("occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_source_occurred_idx" ON "events" ("source_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_resource_occurred_idx" ON "events" ("resource_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_severity_idx" ON "events" ("severity");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_event_type_idx" ON "events" ("event_type");
