import type { Adapter, AdapterContext, NormalizedEvent, ResourceDraft } from "../types.js";
import { compactKey } from "../utils/hash.js";
import { parseDate } from "../utils/time.js";
import { asRecord, compactRecord, defaultSeverity, numberValue, stringValue } from "./helpers.js";

export const plexAdapter: Adapter = {
  app: "plex",
  normalizeWebhook(payload, context) {
    return [normalizePlexPayload(payload, context)];
  },
};

function normalizePlexPayload(payload: unknown, context: AdapterContext): NormalizedEvent {
  const record = asRecord(payload);
  const metadata = asRecord(record.Metadata);
  const account = asRecord(record.Account);
  const player = asRecord(record.Player);
  const event = stringValue(record.event) ?? "plex.event";
  const resource = plexResource(metadata);
  const occurredAt = parseDate(metadata.updatedAt ?? metadata.addedAt, context.now);
  const lowValue = ["media.pause", "media.resume", "media.stop"].includes(event);
  const ratingKey = stringValue(metadata.ratingKey);
  const accountId = stringValue(account.id);
  const playerUuid = stringValue(player.uuid);
  const correlationId = stringValue(metadata.guid) ?? ratingKey ?? resource.title;

  return {
    eventType: event.replace(/\./g, "-"),
    severity: defaultSeverity(event, event.includes("corrupted") ? "error" : "info"),
    title: plexTitle(event, resource, account),
    message: stringValue(player.title),
    occurredAt,
    resource,
    dedupeKey: compactKey("plex", context.source.key, event, ratingKey, accountId, playerUuid, occurredAt.toISOString()),
    correlationKey: compactKey("plex", correlationId),
    visibility: lowValue ? "low_value" : "default",
    attributes: compactRecord({
      accountId: account.id,
      accountTitle: account.title,
      playerTitle: player.title,
      server: record.Server,
      owner: record.owner,
      user: record.user,
    }),
  };
}

function plexResource(metadata: Record<string, unknown>): ResourceDraft {
  const title =
    stringValue(metadata.title) ??
    stringValue(metadata.grandparentTitle) ??
    stringValue(metadata.parentTitle) ??
    stringValue(metadata.guid);
  const ratingKey = stringValue(metadata.ratingKey);
  const guid = stringValue(metadata.guid);

  return {
    resourceType: "media",
    title,
    subtitle: stringValue(metadata.parentTitle),
    canonicalKey: guid ? compactKey("plex-guid", guid) : ratingKey ? compactKey("plex", ratingKey) : undefined,
    externalIds: compactRecord({
      plexGuid: guid,
      plexRatingKey: ratingKey,
      librarySectionId: numberValue(metadata.librarySectionID),
    }),
    appRefs: compactRecord({
      ratingKey,
      key: metadata.key,
      parentRatingKey: metadata.parentRatingKey,
      grandparentRatingKey: metadata.grandparentRatingKey,
    }),
  };
}

function plexTitle(event: string, resource: ResourceDraft, account: Record<string, unknown>): string {
  const user = stringValue(account.title);
  const subject = resource.title ?? "Plex media";
  const action = event.replace(/^media\./, "").replace(/^library\./, "").replace(/\./g, " ");
  return user ? `${user} ${action} ${subject}` : `${subject} ${action}`;
}
