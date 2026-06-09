import { existsSync } from "node:fs";
import { join } from "node:path";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { getAdapter } from "../adapters/index.js";
import { bearerToken, tokenMatches } from "../auth.js";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { sources } from "../db/schema.js";
import { ingestNormalized, listResources, queryEvents } from "../ingest/service.js";
import { runtimeSourceByKey, sourceRowByKey } from "../ingest/source-registry.js";
import type { IngestMethod } from "../types.js";
import { runBackfillOnce } from "../workers/backfill.js";

const eventQuerySchema = z.object({
  app: z.string().optional(),
  sourceKey: z.string().optional(),
  severity: z.string().optional(),
  eventType: z.string().optional(),
  resource: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  grouped: z.coerce.boolean().default(false),
  includeLowValue: z.coerce.boolean().default(false),
});

const resourceQuerySchema = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function createApp(config: AppConfig, db: Database): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  void app.register(multipart, {
    limits: {
      fileSize: 2 * 1024 * 1024,
      files: 2,
      fields: 10,
    },
  });

  app.get("/healthz", async () => {
    await db.execute(sql`select 1`);
    return { ok: true };
  });

  app.post("/ingest/:sourceKey/:adapter", async (request, reply) => {
    const params = z.object({ sourceKey: z.string(), adapter: z.string() }).parse(request.params);
    const source = runtimeSourceByKey(config, params.sourceKey);
    if (!source) {
      return reply.code(404).send({ error: "unknown_source" });
    }

    if (!tokenMatches(bearerToken(request), source.ingestToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    if (params.adapter !== source.app && !(source.app === "sonarr" && params.adapter === "servarr") && !(source.app === "radarr" && params.adapter === "servarr")) {
      return reply.code(400).send({ error: "adapter_mismatch", expected: source.app });
    }

    const sourceRow = await sourceRowByKey(db, source.key);
    if (!sourceRow) {
      return reply.code(500).send({ error: "source_not_synced" });
    }

    const payload = await readIngestPayload(request);
    const adapter = getAdapter(source.app);
    const ingestMethod = ingestMethodFor(source.app);
    const normalizedEvents = adapter.normalizeWebhook(payload, {
      source,
      ingestMethod,
      now: new Date(),
    });
    const result = await ingestNormalized(db, {
      source,
      sourceRow,
      adapter: adapter.app,
      ingestMethod,
      payload,
      normalizedEvents,
    });

    return reply.code(202).send({
      accepted: true,
      rawEventId: result.rawEventId,
      normalizedEvents: normalizedEvents.length,
      insertedEvents: result.insertedEvents,
    });
  });

  app.get("/api/events", async (request) => {
    const query = eventQuerySchema.parse(request.query);
    const rows = await queryEvents(db, {
      app: query.app,
      sourceKey: query.sourceKey,
      severity: query.severity,
      eventType: query.eventType,
      resource: query.resource,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit,
      includeLowValue: query.includeLowValue,
    });

    if (query.grouped) {
      return {
        groups: groupRows(rows),
        nextCursor: rows.at(-1)?.occurredAt?.toISOString(),
      };
    }

    return {
      events: rows,
      nextCursor: rows.at(-1)?.occurredAt?.toISOString(),
    };
  });

  app.get("/api/resources", async (request) => {
    const query = resourceQuerySchema.parse(request.query);
    return { resources: await listResources(db, query.search, query.limit) };
  });

  app.get("/api/sources", async () => {
    const rows = await db.select().from(sources).orderBy(sources.key);
    return {
      sources: rows.map((source) => ({
        key: source.key,
        app: source.app,
        name: source.name,
        baseUrl: source.baseUrl,
        enabled: source.enabled,
        capabilities: source.capabilities,
        secretRefs: source.secretRefs,
      })),
    };
  });

  app.post("/api/sync/:sourceKey/backfill", async (request, reply) => {
    if (!tokenMatches(bearerToken(request), config.adminToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const params = z.object({ sourceKey: z.string() }).parse(request.params);
    const result = await runBackfillOnce(db, config, params.sourceKey);
    return { backfill: result };
  });

  const webRoot = join(process.cwd(), "dist/web");
  if (existsSync(webRoot)) {
    void app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });

    app.get("/", async (_request, reply) => reply.sendFile("index.html"));
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: "validation_error", issues: error.issues });
    }

    app.log.error(error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return reply.code(500).send({ error: "internal_error", message });
  });

  return app;
}

function ingestMethodFor(app: string): IngestMethod {
  return app === "sabnzbd" ? "notification-script" : "webhook";
}

async function readIngestPayload(request: FastifyRequest): Promise<unknown> {
  if (!request.isMultipart()) {
    return request.body ?? {};
  }

  const parts = request.parts();
  const payload: Record<string, unknown> = {};
  const attachments: Array<Record<string, unknown>> = [];

  for await (const part of parts) {
    if (part.type === "field") {
      if (part.fieldname === "payload" && typeof part.value === "string") {
        Object.assign(payload, JSON.parse(part.value));
      } else {
        payload[part.fieldname] = part.value;
      }
    } else {
      attachments.push({
        fieldname: part.fieldname,
        filename: part.filename,
        encoding: part.encoding,
        mimetype: part.mimetype,
      });
      part.file.resume();
    }
  }

  if (attachments.length > 0) {
    payload._attachments = attachments;
  }

  return payload;
}

function groupRows(rows: Awaited<ReturnType<typeof queryEvents>>) {
  const groups = new Map<string, { key: string; title: string; severity: string; count: number; firstAt: Date; lastAt: Date; events: typeof rows }>();

  for (const row of rows) {
    const key = row.correlationKey ?? row.resource?.canonicalKey ?? row.dedupeKey;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        title: row.resource?.title ?? row.title,
        severity: row.severity,
        count: 1,
        firstAt: row.occurredAt,
        lastAt: row.occurredAt,
        events: [row],
      });
      continue;
    }

    existing.count += 1;
    existing.events.push(row);
    if (row.occurredAt < existing.firstAt) {
      existing.firstAt = row.occurredAt;
    }
    if (row.occurredAt > existing.lastAt) {
      existing.lastAt = row.occurredAt;
    }
    if (severityRank(row.severity) > severityRank(existing.severity)) {
      existing.severity = row.severity;
    }
  }

  return [...groups.values()];
}

function severityRank(severity: string): number {
  return { success: 1, info: 2, warning: 3, error: 4 }[severity] ?? 0;
}
