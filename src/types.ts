export const appKinds = ["sonarr", "radarr", "sabnzbd", "tautulli", "overseerr"] as const;
export type AppKind = (typeof appKinds)[number];

export const severities = ["success", "info", "warning", "error"] as const;
export type Severity = (typeof severities)[number];

export const ingestMethods = ["webhook", "poll", "backfill", "notification-script"] as const;
export type IngestMethod = (typeof ingestMethods)[number];

export const visibilityKinds = ["default", "low_value"] as const;
export type Visibility = (typeof visibilityKinds)[number];

export interface SourceConfig {
  key: string;
  name: string;
  app: AppKind;
  baseUrl?: string;
  apiKeyEnv?: string;
  ingestTokenEnv?: string;
  enabled?: boolean;
  pollIntervalSeconds?: number;
}

export interface RuntimeSource extends SourceConfig {
  enabled: boolean;
  apiKey?: string;
  ingestToken?: string;
}

export interface ResourceDraft {
  resourceType: "media" | "download" | "user" | "system" | "unknown";
  title?: string;
  subtitle?: string;
  canonicalKey?: string;
  externalIds?: Record<string, unknown>;
  appRefs?: Record<string, unknown>;
}

export interface NormalizedEvent {
  eventType: string;
  severity: Severity;
  title: string;
  message?: string;
  occurredAt?: Date;
  resource?: ResourceDraft;
  dedupeKey: string;
  correlationKey?: string;
  visibility?: Visibility;
  attributes?: Record<string, unknown>;
}

export interface BackfillResult {
  events: NormalizedEvent[];
  rawPayloads: unknown[];
  cursor?: Record<string, unknown>;
}

export interface AdapterContext {
  source: RuntimeSource;
  ingestMethod: IngestMethod;
  now: Date;
}

export interface Adapter {
  app: AppKind;
  normalizeWebhook(payload: unknown, context: AdapterContext): NormalizedEvent[];
  backfill?(source: RuntimeSource, cursor: Record<string, unknown> | undefined): Promise<BackfillResult>;
  pollStatus?(source: RuntimeSource, cursor: Record<string, unknown> | undefined): Promise<BackfillResult>;
}
