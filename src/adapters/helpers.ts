import type { ResourceDraft, Severity } from "../types.js";
import { compactKey } from "../utils/hash.js";

export type AnyRecord = Record<string, unknown>;

export function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

export function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function compactRecord(input: Record<string, unknown | undefined | null>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

export function defaultSeverity(value: unknown, fallback: Severity = "info"): Severity {
  const normalized = String(value ?? "").toLowerCase();
  if (["error", "failed", "failure", "fatal", "disk_full"].includes(normalized)) {
    return "error";
  }
  if (["warning", "warn", "healthwarning"].includes(normalized)) {
    return "warning";
  }
  if (["complete", "completed", "download", "import", "upgrade", "available", "success"].includes(normalized)) {
    return "success";
  }
  return fallback;
}

export function canonicalResourceKey(resource: ResourceDraft, sourceKey: string): string {
  if (resource.canonicalKey) {
    return resource.canonicalKey;
  }

  const ids = resource.externalIds ?? {};
  const appRefs = resource.appRefs ?? {};
  const preferred =
    ids.tmdbId ??
    ids.tvdbId ??
    ids.imdbId ??
    ids.plexGuid ??
    appRefs.nzoId ??
    appRefs.overseerrRequestId ??
    appRefs.arrId;

  const primitivePreferred =
    typeof preferred === "string" || typeof preferred === "number" || typeof preferred === "boolean"
      ? preferred
      : undefined;

  return compactKey(resource.resourceType, primitivePreferred ?? sourceKey, resource.title ?? "unknown");
}
