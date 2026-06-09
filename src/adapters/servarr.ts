import type { Adapter, AdapterContext, BackfillResult, NormalizedEvent, ResourceDraft, RuntimeSource } from "../types.js";
import { compactKey } from "../utils/hash.js";
import { fetchJson, sourceUrl, withApiKey } from "../utils/http.js";
import { parseDate } from "../utils/time.js";
import { asRecord, compactRecord, defaultSeverity, numberValue, stringValue } from "./helpers.js";

interface ServarrHistoryResponse {
  records?: unknown[];
  page?: number;
  totalRecords?: number;
}

export function createServarrAdapter(app: "sonarr" | "radarr"): Adapter {
  return {
    app,
    normalizeWebhook(payload, context) {
      return [normalizeServarrPayload(app, payload, context)];
    },
    async backfill(source, cursor) {
      return backfillServarr(app, source, cursor);
    },
  };
}

async function backfillServarr(
  app: "sonarr" | "radarr",
  source: RuntimeSource,
  cursor: Record<string, unknown> | undefined,
): Promise<BackfillResult> {
  const page = typeof cursor?.page === "number" ? cursor.page : 1;
  const url = sourceUrl(source, "/api/v3/history");
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("sortKey", "date");
  url.searchParams.set("sortDirection", "ascending");
  withApiKey(url, source);

  const response = await fetchJson<ServarrHistoryResponse>(url);
  const records = response.records ?? [];
  const now = new Date();
  const events = records.map((record) =>
    normalizeServarrPayload(app, record, { source, ingestMethod: "backfill", now }),
  );

  const totalRecords = response.totalRecords ?? records.length;
  const nextPage = page * 100 < totalRecords ? page + 1 : page;

  return {
    events,
    rawPayloads: records,
    cursor: {
      page: nextPage,
      complete: nextPage === page,
      totalRecords,
    },
  };
}

function normalizeServarrPayload(app: "sonarr" | "radarr", payload: unknown, context: AdapterContext): NormalizedEvent {
  const record = asRecord(payload);
  const data = asRecord(record.data);
  const eventType = normalizeEventType(stringValue(record.eventType) ?? stringValue(record.event_type) ?? stringValue(record.eventTypeName) ?? "history");
  const occurredAt = parseDate(record.date ?? record.eventDate ?? record.timestamp, context.now);
  const resource = app === "sonarr" ? sonarrResource(record) : radarrResource(record);
  const resourceKey = resource.canonicalKey ?? compactKey(resource.resourceType, resource.title, context.source.key);
  const historyId = stringValue(record.id) ?? stringValue(record.historyId) ?? stringValue(data.downloadId);
  const quality = asRecord(asRecord(record.quality).quality);

  return {
    eventType,
    severity: severityForServarr(eventType, record),
    title: titleForServarr(app, eventType, record, resource),
    message: stringValue(record.sourceTitle) ?? stringValue(record.message) ?? stringValue(data.message),
    occurredAt,
    resource,
    dedupeKey: compactKey("servarr", context.source.key, eventType, historyId ?? resourceKey, occurredAt.toISOString()),
    correlationKey: compactKey(app, resourceKey),
    attributes: compactRecord({
      app,
      quality: quality.name ?? asRecord(record.quality).name ?? data.quality,
      downloadClient: data.downloadClient,
      sourceTitle: record.sourceTitle,
      successful: record.successful,
    }),
  };
}

function normalizeEventType(value: string): string {
  const normalized = value.toLowerCase().replace(/[\s_]+/g, "-");
  const map: Record<string, string> = {
    grab: "grabbed",
    download: "imported",
    import: "imported",
    moviefiledelete: "file-deleted",
    episodefiledelete: "file-deleted",
    downloadfolderimported: "imported",
    healthissue: "health-issue",
    applicationupdate: "application-updated",
  };
  return map[normalized] ?? normalized;
}

function severityForServarr(eventType: string, record: Record<string, unknown>) {
  if (eventType.includes("health")) {
    return defaultSeverity(record.level ?? record.type, "error");
  }

  if (eventType.includes("failed") || record.successful === false) {
    return "error";
  }

  if (["imported", "upgraded", "grabbed"].includes(eventType)) {
    return "success";
  }

  return "info";
}

function titleForServarr(
  app: "sonarr" | "radarr",
  eventType: string,
  record: Record<string, unknown>,
  resource: ResourceDraft,
): string {
  const label = eventType.replace(/-/g, " ");
  const subject = resource.title ?? stringValue(record.sourceTitle) ?? (app === "sonarr" ? "series" : "movie");
  return `${subject} ${label}`;
}

function sonarrResource(record: Record<string, unknown>): ResourceDraft {
  const series = asRecord(record.series);
  const episode = asRecord(record.episode);
  const data = asRecord(record.data);
  const title = stringValue(series.title) ?? stringValue(record.seriesTitle) ?? stringValue(record.sourceTitle);
  const tvdbId = numberValue(series.tvdbId) ?? numberValue(data.tvdbId);
  const imdbId = stringValue(series.imdbId) ?? stringValue(data.imdbId);
  const arrId = numberValue(series.id) ?? numberValue(record.seriesId);
  const episodeId = numberValue(episode.id) ?? numberValue(record.episodeId);

  return {
    resourceType: "media",
    title,
    subtitle: stringValue(episode.title),
    canonicalKey: tvdbId ? compactKey("tvdb", tvdbId) : arrId ? compactKey("sonarr", arrId) : undefined,
    externalIds: compactRecord({ tvdbId, imdbId }),
    appRefs: compactRecord({ arrId, episodeId }),
  };
}

function radarrResource(record: Record<string, unknown>): ResourceDraft {
  const movie = asRecord(record.movie);
  const data = asRecord(record.data);
  const title = stringValue(movie.title) ?? stringValue(record.movieTitle) ?? stringValue(record.sourceTitle);
  const tmdbId = numberValue(movie.tmdbId) ?? numberValue(data.tmdbId);
  const imdbId = stringValue(movie.imdbId) ?? stringValue(data.imdbId);
  const arrId = numberValue(movie.id) ?? numberValue(record.movieId);

  return {
    resourceType: "media",
    title,
    canonicalKey: tmdbId ? compactKey("tmdb", tmdbId) : imdbId ? compactKey("imdb", imdbId) : arrId ? compactKey("radarr", arrId) : undefined,
    externalIds: compactRecord({ tmdbId, imdbId }),
    appRefs: compactRecord({ arrId }),
  };
}
