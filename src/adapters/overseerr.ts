import type { Adapter, AdapterContext, BackfillResult, NormalizedEvent, ResourceDraft, RuntimeSource } from "../types.js";
import { compactKey } from "../utils/hash.js";
import { fetchJson, sourceUrl } from "../utils/http.js";
import { parseDate } from "../utils/time.js";
import { asArray, asRecord, compactRecord, defaultSeverity, numberValue, stringValue } from "./helpers.js";

interface OverseerrRequestsResponse {
  results?: unknown[];
  pageInfo?: {
    pages?: number;
    page?: number;
  };
}

export const overseerrAdapter: Adapter = {
  app: "overseerr",
  normalizeWebhook(payload, context) {
    return [normalizeOverseerrPayload(payload, context)];
  },
  async backfill(source, cursor) {
    return backfillOverseerr(source, cursor);
  },
};

async function backfillOverseerr(
  source: RuntimeSource,
  cursor: Record<string, unknown> | undefined,
): Promise<BackfillResult> {
  const page = typeof cursor?.page === "number" ? cursor.page : 1;
  const url = sourceUrl(source, "/api/v1/request");
  url.searchParams.set("take", "100");
  url.searchParams.set("skip", String((page - 1) * 100));
  if (!source.apiKey) {
    throw new Error(`Source ${source.key} is missing API key from ${source.apiKeyEnv ?? "apiKeyEnv"}`);
  }

  const response = await fetchJson<OverseerrRequestsResponse>(url, {
    headers: {
      "X-Api-Key": source.apiKey,
    },
  });
  const records = response.results ?? [];
  const now = new Date();
  const events = records.map((record) =>
    normalizeOverseerrPayload(record, { source, ingestMethod: "backfill", now }),
  );
  const pages = response.pageInfo?.pages ?? page;

  return {
    events,
    rawPayloads: records,
    cursor: {
      page: page < pages ? page + 1 : page,
      complete: page >= pages,
    },
  };
}

function normalizeOverseerrPayload(payload: unknown, context: AdapterContext): NormalizedEvent {
  const record = asRecord(payload);
  const media = asRecord(record.media);
  const request = asRecord(record.request).id ? asRecord(record.request) : record;
  const issue = asRecord(record.issue);
  const notificationType =
    stringValue(record.notification_type) ??
    stringValue(record.notificationType) ??
    stringValue(record.type) ??
    stringValue(record.event) ??
    statusToType(stringValue(request.status));
  const resource = overseerrResource(record, media, request);
  const requestId = stringValue(request.id) ?? stringValue(record.request_id);
  const occurredAt = parseDate(record.createdAt ?? request.createdAt ?? record.updatedAt ?? request.updatedAt, context.now);

  return {
    eventType: normalizeOverseerrType(notificationType),
    severity: severityForOverseerr(notificationType),
    title: stringValue(record.subject) ?? `${resource.title ?? "Request"} ${normalizeOverseerrType(notificationType)}`,
    message: stringValue(record.message) ?? stringValue(issue.message) ?? stringValue(record.event),
    occurredAt,
    resource,
    dedupeKey: compactKey("overseerr", context.source.key, notificationType, requestId, occurredAt.toISOString()),
    correlationKey: compactKey("overseerr", resource.canonicalKey ?? requestId ?? resource.title),
    attributes: compactRecord({
      requestId,
      requestedBy: publicUser(request.requestedBy ?? record.requestedBy),
      seasons: asArray(request.seasons ?? record.extra),
      issueId: issue.id ?? record.issue_id,
    }),
  };
}

function publicUser(value: unknown): Record<string, unknown> | undefined {
  const user = asRecord(value);
  const id = numberValue(user.id) ?? stringValue(user.id);
  const displayName =
    stringValue(user.displayName) ??
    stringValue(user.plexUsername) ??
    stringValue(user.username);

  return Object.keys(compactRecord({ id, displayName })).length > 0
    ? compactRecord({ id, displayName })
    : undefined;
}

function overseerrResource(
  record: Record<string, unknown>,
  media: Record<string, unknown>,
  request: Record<string, unknown>,
): ResourceDraft {
  const subject = stringValue(record.subject);
  const mediaType = stringValue(media.mediaType) ?? stringValue(media.media_type) ?? stringValue(record.media_type);
  const tmdbId = numberValue(media.tmdbId) ?? numberValue(media.tmdbid) ?? numberValue(record.media_tmdbid);
  const tvdbId = numberValue(media.tvdbId) ?? numberValue(media.tvdbid) ?? numberValue(record.media_tvdbid);
  const requestId = stringValue(request.id) ?? stringValue(record.request_id);

  return {
    resourceType: "media",
    title: subject ?? stringValue(media.title) ?? stringValue(request.title),
    subtitle: mediaType,
    canonicalKey: tmdbId ? compactKey("tmdb", tmdbId) : tvdbId ? compactKey("tvdb", tvdbId) : requestId ? compactKey("overseerr-request", requestId) : undefined,
    externalIds: compactRecord({ tmdbId, tvdbId }),
    appRefs: compactRecord({ overseerrRequestId: requestId, mediaType }),
  };
}

function statusToType(status?: string): string {
  const map: Record<string, string> = {
    "1": "MEDIA_PENDING",
    "2": "MEDIA_APPROVED",
    "3": "MEDIA_DECLINED",
    "4": "MEDIA_AVAILABLE",
    "5": "MEDIA_FAILED",
  };
  return status ? map[status] ?? status : "OVERSEERR_EVENT";
}

function normalizeOverseerrType(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function severityForOverseerr(value: string) {
  const normalized = normalizeOverseerrType(value);
  if (normalized.includes("failed") || normalized.includes("declined") || normalized.includes("issue")) {
    return normalized.includes("issue-comment") ? "info" : "error";
  }
  if (normalized.includes("available") || normalized.includes("approved")) {
    return "success";
  }
  return defaultSeverity(normalized, "info");
}
