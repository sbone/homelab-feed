import type { Adapter, AdapterContext, BackfillResult, NormalizedEvent, ResourceDraft, RuntimeSource } from "../types.js";
import { compactKey } from "../utils/hash.js";
import { fetchJson, sourceUrl, withApiKey } from "../utils/http.js";
import { parseDate } from "../utils/time.js";
import { asArray, asRecord, compactRecord, defaultSeverity, stringValue } from "./helpers.js";

interface SabHistoryResponse {
  history?: {
    last_history_update?: number;
    slots?: unknown[];
  };
}

interface SabQueueResponse {
  queue?: {
    slots?: unknown[];
  };
}

export const sabnzbdAdapter: Adapter = {
  app: "sabnzbd",
  normalizeWebhook(payload, context) {
    const record = asRecord(payload);
    if (record.notificationType || record.type) {
      return [normalizeNotification(record, context)];
    }
    return [normalizeHistorySlot(record, context)];
  },
  async backfill(source, cursor) {
    const url = sourceUrl(source, "/api");
    url.searchParams.set("mode", "history");
    url.searchParams.set("output", "json");
    url.searchParams.set("limit", "100");
    if (typeof cursor?.last_history_update === "number") {
      url.searchParams.set("last_history_update", String(cursor.last_history_update));
    }
    withApiKey(url, source);

    const response = await fetchJson<SabHistoryResponse>(url);
    const slots = response.history?.slots ?? [];
    const now = new Date();
    return {
      events: slots.map((slot) => normalizeHistorySlot(slot, { source, ingestMethod: "backfill", now })),
      rawPayloads: slots,
      cursor: {
        last_history_update: response.history?.last_history_update ?? cursor?.last_history_update ?? null,
      },
    };
  },
  async pollStatus(source) {
    const url = sourceUrl(source, "/api");
    url.searchParams.set("mode", "queue");
    url.searchParams.set("output", "json");
    withApiKey(url, source);
    const response = await fetchJson<SabQueueResponse>(url);
    const slots = response.queue?.slots ?? [];
    const now = new Date();
    return {
      events: slots.map((slot) => normalizeQueueSlot(slot, { source, ingestMethod: "poll", now })),
      rawPayloads: slots,
      cursor: { polledAt: now.toISOString() },
    };
  },
};

function normalizeNotification(record: Record<string, unknown>, context: AdapterContext): NormalizedEvent {
  const notificationType = stringValue(record.notificationType) ?? stringValue(record.type) ?? "other";
  const title = stringValue(record.title) ?? stringValue(record.notificationTitle) ?? `SABnzbd ${notificationType}`;
  const text = stringValue(record.message) ?? stringValue(record.notificationText);

  return {
    eventType: normalizeSabType(notificationType),
    severity: defaultSeverity(notificationType, "info"),
    title,
    message: text,
    occurredAt: context.now,
    resource: { resourceType: "system", title: "SABnzbd" },
    dedupeKey: compactKey("sabnzbd", context.source.key, notificationType, title, text, context.now.toISOString()),
    correlationKey: compactKey("sabnzbd", notificationType),
    attributes: record,
  };
}

function normalizeHistorySlot(payload: unknown, context: AdapterContext): NormalizedEvent {
  const slot = asRecord(payload);
  const status = stringValue(slot.status) ?? "unknown";
  const resource = sabDownloadResource(slot);
  const completed = parseDate(slot.completed ?? slot.time_added, context.now);
  const nzoId = stringValue(slot.nzo_id) ?? stringValue(slot.nzoId);

  return {
    eventType: normalizeSabType(status),
    severity: defaultSeverity(status, "info"),
    title: `${resource.title ?? "Download"} ${status.toLowerCase()}`,
    message: stringValue(slot.fail_message) ?? stringValue(slot.action_line) ?? stringValue(slot.script_line),
    occurredAt: completed,
    resource,
    dedupeKey: compactKey("sabnzbd", context.source.key, "history", nzoId ?? resource.title, status, completed.toISOString()),
    correlationKey: compactKey("download", nzoId ?? resource.title),
    attributes: compactRecord({
      category: slot.category,
      downloaded: slot.downloaded,
      bytes: slot.bytes,
    }),
  };
}

function normalizeQueueSlot(payload: unknown, context: AdapterContext): NormalizedEvent {
  const slot = asRecord(payload);
  const status = stringValue(slot.status) ?? "queued";
  const resource = sabDownloadResource(slot);
  const nzoId = stringValue(slot.nzo_id) ?? stringValue(slot.nzoId);

  return {
    eventType: "download-active",
    severity: defaultSeverity(status, "info"),
    title: `${resource.title ?? "Download"} ${status.toLowerCase()}`,
    message: stringValue(slot.labels) ?? asArray(slot.labels).join(", "),
    occurredAt: parseDate(slot.time_added, context.now),
    resource,
    dedupeKey: compactKey("sabnzbd", context.source.key, "queue", nzoId, status, stringValue(slot.percentage)),
    correlationKey: compactKey("download", nzoId ?? resource.title),
    visibility: "low_value",
    attributes: compactRecord({
      status,
      percentage: slot.percentage,
      category: slot.cat,
      size: slot.size,
      sizeLeft: slot.sizeleft,
    }),
  };
}

function sabDownloadResource(slot: Record<string, unknown>): ResourceDraft {
  const nzoId = stringValue(slot.nzo_id) ?? stringValue(slot.nzoId);
  const title = stringValue(slot.name) ?? stringValue(slot.filename) ?? stringValue(slot.nzb_name) ?? nzoId;

  return {
    resourceType: "download",
    title,
    canonicalKey: nzoId ? compactKey("sabnzbd", nzoId) : title ? compactKey("download", title) : undefined,
    appRefs: compactRecord({ nzoId, category: slot.category ?? slot.cat }),
  };
}

function normalizeSabType(value: string): string {
  const normalized = value.toLowerCase().replace(/[\s_]+/g, "-");
  const map: Record<string, string> = {
    completed: "download-completed",
    complete: "download-completed",
    failed: "download-failed",
    warning: "warning",
    error: "error",
    "disk-full": "disk-full",
    "queue-done": "queue-finished",
  };
  return map[normalized] ?? normalized;
}
