import { eq } from "drizzle-orm";
import { sourceSecretRefs, type AppConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { sources, type SourceRow } from "../db/schema.js";
import type { RuntimeSource } from "../types.js";

export async function syncConfiguredSources(db: Database, config: AppConfig): Promise<void> {
  for (const source of config.sources) {
    await db
      .insert(sources)
      .values({
        key: source.key,
        app: source.app,
        name: source.name,
        baseUrl: source.baseUrl,
        enabled: source.enabled,
        capabilities: capabilitiesFor(source),
        secretRefs: sourceSecretRefs(source),
      })
      .onConflictDoUpdate({
        target: sources.key,
        set: {
          app: source.app,
          name: source.name,
          baseUrl: source.baseUrl,
          enabled: source.enabled,
          capabilities: capabilitiesFor(source),
          secretRefs: sourceSecretRefs(source),
          updatedAt: new Date(),
        },
      });
  }
}

export async function sourceRowByKey(db: Database, key: string): Promise<SourceRow | undefined> {
  const [row] = await db.select().from(sources).where(eq(sources.key, key)).limit(1);
  return row;
}

export function runtimeSourceByKey(config: AppConfig, key: string): RuntimeSource | undefined {
  return config.sources.find((source) => source.key === key && source.enabled);
}

function capabilitiesFor(source: RuntimeSource): string[] {
  const base = ["webhook"];
  if (source.app === "plex") {
    return base;
  }
  if (source.app === "sabnzbd") {
    return [...base, "pollHistory", "pollStatus"];
  }
  return [...base, "pollHistory"];
}
