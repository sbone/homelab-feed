import { getAdapter } from "../adapters/index.js";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { getCursor, ingestNormalized, setCursor } from "../ingest/service.js";
import { runtimeSourceByKey, sourceRowByKey } from "../ingest/source-registry.js";

export interface BackfillSummary {
  sourceKey: string;
  cursorKey: string;
  rawPayloads: number;
  normalizedEvents: number;
  insertedEvents: number;
  cursor?: Record<string, unknown>;
}

export async function runBackfillOnce(
  db: Database,
  config: AppConfig,
  sourceKey: string,
): Promise<BackfillSummary> {
  const source = runtimeSourceByKey(config, sourceKey);
  if (!source) {
    throw new Error(`Unknown or disabled source: ${sourceKey}`);
  }

  const sourceRow = await sourceRowByKey(db, sourceKey);
  if (!sourceRow) {
    throw new Error(`Source ${sourceKey} has not been synced to the database`);
  }

  const adapter = getAdapter(source.app);
  if (!adapter.backfill) {
    throw new Error(`Source ${sourceKey} (${source.app}) does not support backfill`);
  }

  const cursorKey = "backfill";
  const cursor = await getCursor(db, sourceRow.id, cursorKey);
  const result = await adapter.backfill(source, cursor);
  let insertedEvents = 0;

  for (let index = 0; index < result.rawPayloads.length; index += 1) {
    const payload = result.rawPayloads[index];
    const normalized = result.events[index] ? [result.events[index]] : [];
    const ingest = await ingestNormalized(db, {
      source,
      sourceRow,
      adapter: adapter.app,
      ingestMethod: "backfill",
      payload,
      normalizedEvents: normalized,
    });
    insertedEvents += ingest.insertedEvents;
  }

  if (result.cursor) {
    await setCursor(db, sourceRow.id, cursorKey, result.cursor);
  }

  return {
    sourceKey,
    cursorKey,
    rawPayloads: result.rawPayloads.length,
    normalizedEvents: result.events.length,
    insertedEvents,
    cursor: result.cursor,
  };
}
