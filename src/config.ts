import { readFileSync } from "node:fs";
import { z } from "zod";
import { appKinds, type RuntimeSource, type SourceConfig } from "./types.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const sourceConfigSchema = z.object({
  key: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1),
  app: z.enum(appKinds),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  ingestTokenEnv: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().positive().optional(),
});

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().min(1),
  ADMIN_TOKEN: z.string().min(16),
  HOMELAB_FEED_SOURCES: z.string().default("[]"),
});

export interface AppConfig {
  port: number;
  host: string;
  databaseUrl: string;
  adminToken: string;
  sources: RuntimeSource[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = parseEnv(env);
  const rawSources = parseSourceText(parsed.HOMELAB_FEED_SOURCES);
  const sources = parseSources(rawSources).map((source) => toRuntimeSource(source, env));
  validateSourceSecrets(sources);

  return {
    port: parsed.PORT,
    host: parsed.HOST,
    databaseUrl: parsed.DATABASE_URL,
    adminToken: parsed.ADMIN_TOKEN,
    sources,
  };
}

function parseSourceText(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const jsonText = trimmed.startsWith("@") ? readFileSync(trimmed.slice(1), "utf8") : trimmed;
    return JSON.parse(jsonText);
  } catch (error) {
    const target = trimmed.startsWith("@") ? trimmed.slice(1) : "HOMELAB_FEED_SOURCES";
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new ConfigError(`Could not read source config from ${target}: ${detail}`);
  }
}

function toRuntimeSource(source: SourceConfig, env: NodeJS.ProcessEnv): RuntimeSource {
  return {
    ...source,
    enabled: source.enabled ?? true,
    apiKey: source.apiKeyEnv ? env[source.apiKeyEnv] : undefined,
    ingestToken: source.ingestTokenEnv ? env[source.ingestTokenEnv] : undefined,
  };
}

function parseEnv(env: NodeJS.ProcessEnv) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(formatZodIssues("environment", result.error));
  }

  if (result.data.ADMIN_TOKEN === "replace-with-a-long-random-token") {
    throw new ConfigError("ADMIN_TOKEN is still the example placeholder. Set it to a long random value in .env.");
  }

  return result.data;
}

function parseSources(rawSources: unknown): SourceConfig[] {
  const result = z.array(sourceConfigSchema).safeParse(rawSources);
  if (result.success) {
    return result.data;
  }

  throw new ConfigError(formatZodIssues("source config", result.error));
}

function validateSourceSecrets(sources: RuntimeSource[]): void {
  const missing = sources.flatMap((source) => {
    if (!source.enabled) {
      return [];
    }

    return [
      source.apiKeyEnv && !source.apiKey ? `${source.key}: ${source.apiKeyEnv}` : undefined,
      source.ingestTokenEnv && !source.ingestToken ? `${source.key}: ${source.ingestTokenEnv}` : undefined,
    ].filter((value): value is string => Boolean(value));
  });

  if (missing.length > 0) {
    throw new ConfigError(`Missing required secret values: ${missing.join(", ")}. Fill them in .env.`);
  }
}

function formatZodIssues(label: string, error: z.ZodError): string {
  return `Invalid ${label}: ${error.issues
    .map((issue) => `${issue.path.join(".") || "value"} ${issue.message}`)
    .join("; ")}`;
}

export function sourceSecretRefs(source: SourceConfig): Record<string, string> {
  return Object.fromEntries(
    [
      ["apiKeyEnv", source.apiKeyEnv],
      ["ingestTokenEnv", source.ingestTokenEnv],
    ].filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
