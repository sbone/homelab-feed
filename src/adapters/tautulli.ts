import type { Adapter, AdapterContext, BackfillResult, NormalizedEvent, ResourceDraft, RuntimeSource } from "../types.js";
import { compactKey } from "../utils/hash.js";
import { fetchJson, sourceUrl, withApiKey } from "../utils/http.js";
import { parseDate } from "../utils/time.js";
import { asArray, asRecord, compactRecord, numberValue, stringValue } from "./helpers.js";

interface TautulliResponse<T> {
  response?: {
    result?: string;
    message?: string | null;
    data?: T;
  };
}

interface HistoryResponse {
  data?: unknown[];
}

interface RecentlyAddedResponse {
  recently_added?: unknown[];
}

interface ActivityResponse {
  sessions?: unknown[];
}

export const tautulliAdapter: Adapter = {
  app: "tautulli",
  normalizeWebhook(payload, context) {
    return [normalizeTautulliWebhook(payload, context)];
  },
  async backfill(source, cursor) {
    return backfillTautulli(source, cursor);
  },
  async pollStatus(source) {
    const records = await tautulliApi<ActivityResponse>(source, "get_activity");
    const now = new Date();
    const sessions = records.sessions ?? [];

    return {
      events: sessions.map((session) => normalizeActivitySession(session, { source, ingestMethod: "poll", now })),
      rawPayloads: sessions,
      cursor: { polledAt: now.toISOString() },
    };
  },
};

async function backfillTautulli(
  source: RuntimeSource,
  cursor: Record<string, unknown> | undefined,
): Promise<BackfillResult> {
  const [history, recentlyAdded, activity] = await Promise.all([
    tautulliApi<HistoryResponse>(source, "get_history", historyParams(cursor)),
    tautulliApi<RecentlyAddedResponse>(source, "get_recently_added", { count: "100" }),
    tautulliApi<ActivityResponse>(source, "get_activity"),
  ]);
  const now = new Date();
  const historyRows = history.data ?? [];
  const recentlyAddedRows = recentlyAdded.recently_added ?? [];
  const activityRows = activity.sessions ?? [];
  const historyEvents = historyRows.map((row) => normalizeHistoryRow(row, { source, ingestMethod: "backfill", now }));
  const recentlyAddedEvents = recentlyAddedRows.map((row) =>
    normalizeRecentlyAdded(row, { source, ingestMethod: "backfill", now }),
  );
  const activityEvents = activityRows.map((row) => normalizeActivitySession(row, { source, ingestMethod: "backfill", now }));

  return {
    events: [...historyEvents, ...recentlyAddedEvents, ...activityEvents],
    rawPayloads: [
      ...historyRows.map((row) => ({ _tautulliCommand: "get_history", ...asRecord(row) })),
      ...recentlyAddedRows.map((row) => ({ _tautulliCommand: "get_recently_added", ...asRecord(row) })),
      ...activityRows.map((row) => ({ _tautulliCommand: "get_activity", ...asRecord(row) })),
    ],
    cursor: {
      historyAfter: newestDate(historyRows, ["date", "stopped", "started"]) ?? cursor?.historyAfter ?? null,
      recentlyAddedAfter: newestDate(recentlyAddedRows, ["added_at", "updated_at"]) ?? cursor?.recentlyAddedAfter ?? null,
      polledAt: now.toISOString(),
    },
  };
}

function historyParams(cursor: Record<string, unknown> | undefined): Record<string, string> {
  const params: Record<string, string> = {
    grouping: "0",
    include_activity: "1",
    order_column: "date",
    order_dir: "desc",
    start: "0",
    length: "100",
  };
  const historyAfter = stringValue(cursor?.historyAfter);

  if (historyAfter) {
    params.after = historyAfter.slice(0, 10);
  }

  return params;
}

async function tautulliApi<T>(
  source: RuntimeSource,
  command: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = sourceUrl(source, "/api/v2");
  url.searchParams.set("cmd", command);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  withApiKey(url, source);

  const envelope = await fetchJson<TautulliResponse<T>>(url);
  if (envelope.response?.result && envelope.response.result !== "success") {
    throw new Error(`Tautulli ${command} failed: ${envelope.response.message ?? "unknown error"}`);
  }

  return (envelope.response?.data ?? ({} as T)) as T;
}

function normalizeTautulliWebhook(payload: unknown, context: AdapterContext): NormalizedEvent {
  const record = asRecord(payload);
  const trigger =
    stringValue(record.trigger) ??
    stringValue(record.event) ??
    stringValue(record.notification_type) ??
    stringValue(record.notificationType) ??
    stringValue(record.action);
  const normalizedTrigger = trigger ? normalizeTautulliType(trigger) : undefined;

  if (normalizedTrigger === "recently-added") {
    return normalizeRecentlyAdded(record, context);
  }
  if (normalizedTrigger === "playback-start" || normalizedTrigger === "stream-started") {
    return normalizeActivitySession(record, context);
  }

  return normalizeHistoryRow(record, context, normalizedTrigger);
}

function normalizeHistoryRow(
  payload: unknown,
  context: AdapterContext,
  forcedType?: string,
): NormalizedEvent {
  const row = asRecord(payload);
  const resource = tautulliResource(row, context.source.key);
  const rowId = stringValue(row.row_id) ?? stringValue(row.id);
  const ratingKey = stringValue(row.rating_key);
  const stopped = parseDate(row.stopped ?? row.date ?? row.started, context.now);
  const watched = numberValue(row.watched_status) === 1 || (numberValue(row.percent_complete) ?? 0) >= 90;
  const eventType = forcedType ?? (watched ? "media-watched" : "media-played");
  const user = displayUser(row);

  return {
    eventType,
    severity: "success",
    title: `${user ? `${user} watched ` : "Watched "}${resource.title ?? "Plex item"}`,
    message: historyMessage(row),
    occurredAt: stopped,
    resource,
    dedupeKey: compactKey("tautulli", context.source.key, "history", rowId ?? ratingKey, stopped.toISOString()),
    correlationKey: compactKey("plex", resource.canonicalKey ?? ratingKey ?? resource.title),
    attributes: compactRecord({
      plex: true,
      rowId,
      user: displayUser(row),
      userId: row.user_id,
      percentComplete: numberValue(row.percent_complete),
      watchedStatus: numberValue(row.watched_status),
      platform: row.platform,
      player: row.player,
      transcodeDecision: row.transcode_decision,
    }),
  };
}

function normalizeRecentlyAdded(payload: unknown, context: AdapterContext): NormalizedEvent {
  const row = asRecord(payload);
  const resource = tautulliResource(row, context.source.key);
  const ratingKey = stringValue(row.rating_key);
  const addedAt = parseDate(row.added_at ?? row.updated_at, context.now);

  return {
    eventType: "library-new",
    severity: "success",
    title: `${mediaLabel(row)} added: ${resource.title ?? "Plex item"}`,
    message: stringValue(row.summary) ?? stringValue(row.library_name),
    occurredAt: addedAt,
    resource,
    dedupeKey: compactKey("tautulli", context.source.key, "recently-added", ratingKey ?? resource.title, addedAt.toISOString()),
    correlationKey: compactKey("plex", resource.canonicalKey ?? ratingKey ?? resource.title),
    attributes: compactRecord({
      plex: true,
      ratingKey,
      libraryName: row.library_name,
      sectionId: row.section_id,
    }),
  };
}

function normalizeActivitySession(payload: unknown, context: AdapterContext): NormalizedEvent {
  const row = asRecord(payload);
  const resource = tautulliResource(row, context.source.key);
  const sessionKey = stringValue(row.session_key) ?? stringValue(row.session_id);
  const startedAt = parseDate(row.started ?? row.view_offset ?? row.added_at, context.now);
  const user = displayUser(row);
  const state = stringValue(row.state) ?? "playing";

  return {
    eventType: state === "paused" ? "playback-paused" : "playback-start",
    severity: "info",
    title: `${user ? `${user} started ` : "Started "}${resource.title ?? "Plex stream"}`,
    message: activityMessage(row),
    occurredAt: startedAt,
    resource,
    dedupeKey: compactKey("tautulli", context.source.key, "activity", sessionKey, state, resource.canonicalKey ?? resource.title),
    correlationKey: compactKey("plex-session", sessionKey ?? resource.canonicalKey ?? resource.title),
    visibility: state === "paused" ? "low_value" : "default",
    attributes: compactRecord({
      plex: true,
      sessionKey,
      sessionId: row.session_id,
      user: displayUser(row),
      userId: row.user_id,
      state,
      platform: row.platform,
      player: row.player,
      product: row.product,
      location: row.location,
      transcodeDecision: row.transcode_decision ?? row.stream_video_decision,
    }),
  };
}

function tautulliResource(row: Record<string, unknown>, sourceKey: string): ResourceDraft {
  const guid = stringValue(row.guid);
  const ratingKey = stringValue(row.rating_key);
  const guids = asArray(row.guids).map((value) => stringValue(value)).filter((value): value is string => Boolean(value));
  const externalIds = externalIdsFromGuids([guid, ...guids]);
  const title = displayTitle(row);
  const year = stringValue(row.year);
  const mediaType = stringValue(row.media_type);
  const thumb = stringValue(row.thumb);

  return {
    resourceType: "media",
    title,
    subtitle: [year, mediaType, stringValue(row.library_name)].filter(Boolean).join(" · ") || undefined,
    canonicalKey: canonicalKeyFor(row, externalIds),
    externalIds: compactRecord({
      ...externalIds,
      plexGuid: guid,
      plexRatingKey: ratingKey,
    }),
    appRefs: compactRecord({
      provider: "plex",
      sourceApp: "tautulli",
      ratingKey,
      mediaType,
      year,
      thumb,
      posterUrl: thumb ? thumbnailUrl(sourceKey, thumb) : undefined,
      art: row.art,
      parentRatingKey: row.parent_rating_key,
      grandparentRatingKey: row.grandparent_rating_key,
    }),
  };
}

function thumbnailUrl(sourceKey: string, path: string): string {
  const params = new URLSearchParams({ sourceKey, path });
  return `/api/thumbnail?${params.toString()}`;
}

function canonicalKeyFor(row: Record<string, unknown>, externalIds: Record<string, string>): string | undefined {
  const ratingKey = stringValue(row.rating_key);
  const guid = stringValue(row.guid);
  if (externalIds.tmdbId) {
    return compactKey("tmdb", externalIds.tmdbId);
  }
  if (externalIds.tvdbId) {
    return compactKey("tvdb", externalIds.tvdbId);
  }
  if (externalIds.imdbId) {
    return compactKey("imdb", externalIds.imdbId);
  }
  if (guid) {
    return compactKey("plex-guid", guid);
  }
  return ratingKey ? compactKey("plex", ratingKey) : undefined;
}

function externalIdsFromGuids(guids: Array<string | undefined>): Record<string, string> {
  const ids: Record<string, string> = {};

  for (const guid of guids) {
    if (!guid) {
      continue;
    }

    const match = /^(imdb|tmdb|tvdb):\/\/([^/?]+)/.exec(guid);
    if (match?.[1] === "imdb") {
      ids.imdbId = match[2];
    }
    if (match?.[1] === "tmdb") {
      ids.tmdbId = match[2];
    }
    if (match?.[1] === "tvdb") {
      ids.tvdbId = match[2];
    }
  }

  return ids;
}

function displayTitle(row: Record<string, unknown>): string | undefined {
  const fullTitle = stringValue(row.full_title);
  if (fullTitle) {
    return fullTitle;
  }

  const mediaType = stringValue(row.media_type);
  const title = stringValue(row.title);
  const grandparentTitle = stringValue(row.grandparent_title);
  if (mediaType === "episode" && grandparentTitle && title) {
    return `${grandparentTitle} - ${title}`;
  }

  return title ?? grandparentTitle ?? stringValue(row.sort_title);
}

function displayUser(row: Record<string, unknown>): string | undefined {
  return stringValue(row.friendly_name) ?? stringValue(row.user) ?? stringValue(row.username);
}

function mediaLabel(row: Record<string, unknown>): string {
  const mediaType = stringValue(row.media_type);
  if (mediaType === "episode") {
    return "Episode";
  }
  if (mediaType === "movie") {
    return "Movie";
  }
  return "Plex item";
}

function historyMessage(row: Record<string, unknown>): string | undefined {
  return [
    numberValue(row.percent_complete) ? `${numberValue(row.percent_complete)}% complete` : undefined,
    stringValue(row.player),
    stringValue(row.transcode_decision),
  ]
    .filter(Boolean)
    .join(" · ") || undefined;
}

function activityMessage(row: Record<string, unknown>): string | undefined {
  return [stringValue(row.player), stringValue(row.product), stringValue(row.transcode_decision ?? row.stream_video_decision)]
    .filter(Boolean)
    .join(" · ") || undefined;
}

function normalizeTautulliType(value: string): string {
  const normalized = value.toLowerCase().replace(/[\s_.]+/g, "-");
  const map: Record<string, string> = {
    "playback-started": "playback-start",
    "playback-start": "playback-start",
    "stream-started": "playback-start",
    "recently-added": "recently-added",
    "watched": "media-watched",
    "media-watched": "media-watched",
  };

  return map[normalized] ?? normalized;
}

function newestDate(rows: unknown[], keys: string[]): string | undefined {
  const dates = rows
    .flatMap((row) => {
      const record = asRecord(row);
      return keys.map((key) => parseDate(record[key], new Date(0)).getTime());
    })
    .filter((value) => Number.isFinite(value) && value > 0);

  if (dates.length === 0) {
    return undefined;
  }

  return new Date(Math.max(...dates)).toISOString();
}
