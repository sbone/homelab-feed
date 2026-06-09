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

interface OverseerrMediaMetadata {
  title?: string;
  year?: string;
  posterPath?: string;
  posterUrl?: string;
  backdropPath?: string;
  imdbId?: string;
  tmdbUrl?: string;
  imdbUrl?: string;
  metacriticUrl?: string;
  overview?: string;
  voteAverage?: number;
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
  const enrichedRecords = await enrichOverseerrRecords(source, records);
  const now = new Date();
  const events = enrichedRecords.map((record) =>
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

async function enrichOverseerrRecords(source: RuntimeSource, records: unknown[]): Promise<unknown[]> {
  const cache = new Map<string, Promise<OverseerrMediaMetadata | undefined>>();

  return mapWithConcurrency(records, 6, async (record) => {
    const value = asRecord(record);
    const media = asRecord(value.media);
    const mediaType = stringValue(media.mediaType) ?? stringValue(value.type);
    const tmdbId = numberValue(media.tmdbId);

    if (!tmdbId || !mediaType || (mediaType !== "movie" && mediaType !== "tv")) {
      return record;
    }

    const key = `${mediaType}:${tmdbId}`;
    if (!cache.has(key)) {
      cache.set(key, fetchOverseerrMediaMetadata(source, mediaType, tmdbId));
    }

    const metadata = await cache.get(key);
    return metadata ? { ...value, _homelabMedia: metadata } : record;
  });
}

async function fetchOverseerrMediaMetadata(
  source: RuntimeSource,
  mediaType: string,
  tmdbId: number,
): Promise<OverseerrMediaMetadata | undefined> {
  if (!source.apiKey) {
    return undefined;
  }

  const path = mediaType === "tv" ? `/api/v1/tv/${tmdbId}` : `/api/v1/movie/${tmdbId}`;
  const url = sourceUrl(source, path);

  try {
    const metadata = asRecord(
      await fetchJson<unknown>(url, {
        headers: {
          "X-Api-Key": source.apiKey,
        },
      }),
    );
    return toMediaMetadata(mediaType, tmdbId, metadata);
  } catch {
    return undefined;
  }
}

function toMediaMetadata(
  mediaType: string,
  tmdbId: number,
  metadata: Record<string, unknown>,
): OverseerrMediaMetadata {
  const title = stringValue(metadata.title) ?? stringValue(metadata.name);
  const date = stringValue(metadata.releaseDate) ?? stringValue(metadata.firstAirDate);
  const year = date?.slice(0, 4);
  const posterPath = stringValue(metadata.posterPath);
  const backdropPath = stringValue(metadata.backdropPath);
  const externalIds = asRecord(metadata.externalIds);
  const imdbId = stringValue(metadata.imdbId) ?? stringValue(externalIds.imdbId);

  return {
    title,
    year,
    posterPath,
    posterUrl: posterPath ? `https://image.tmdb.org/t/p/w342${posterPath}` : undefined,
    backdropPath,
    imdbId,
    tmdbUrl: `https://www.themoviedb.org/${mediaType}/${tmdbId}`,
    imdbUrl: imdbId ? `https://www.imdb.com/title/${imdbId}/` : undefined,
    metacriticUrl: title ? `https://www.metacritic.com/search/${encodeURIComponent(title)}/` : undefined,
    overview: stringValue(metadata.overview),
    voteAverage: numberValue(metadata.voteAverage),
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
  const metadata = asRecord(record._homelabMedia);
  const subject = stringValue(record.subject);
  const mediaType = stringValue(media.mediaType) ?? stringValue(media.media_type) ?? stringValue(record.media_type);
  const tmdbId = numberValue(media.tmdbId) ?? numberValue(media.tmdbid) ?? numberValue(record.media_tmdbid);
  const tvdbId = numberValue(media.tvdbId) ?? numberValue(media.tvdbid) ?? numberValue(record.media_tvdbid);
  const imdbId = stringValue(metadata.imdbId) ?? stringValue(media.imdbId);
  const title = subject ?? stringValue(metadata.title) ?? stringValue(media.title) ?? stringValue(request.title);
  const year = stringValue(metadata.year);
  const requestId = stringValue(request.id) ?? stringValue(record.request_id);

  return {
    resourceType: "media",
    title,
    subtitle: [year, mediaType].filter(Boolean).join(" · ") || undefined,
    canonicalKey: tmdbId ? compactKey("tmdb", tmdbId) : tvdbId ? compactKey("tvdb", tvdbId) : requestId ? compactKey("overseerr-request", requestId) : undefined,
    externalIds: compactRecord({ tmdbId, tvdbId, imdbId }),
    appRefs: compactRecord({
      overseerrRequestId: requestId,
      mediaType,
      year,
      posterPath: metadata.posterPath,
      posterUrl: metadata.posterUrl,
      backdropPath: metadata.backdropPath,
      tmdbUrl: metadata.tmdbUrl,
      imdbUrl: metadata.imdbUrl,
      metacriticUrl: metadata.metacriticUrl,
      overview: metadata.overview,
      voteAverage: metadata.voteAverage,
    }),
  };
}

async function mapWithConcurrency<T, U>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
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
