import { describe, expect, it } from "vitest";
import sonarrWebhook from "./fixtures/sonarr-webhook.json" with { type: "json" };
import radarrHistory from "./fixtures/radarr-history.json" with { type: "json" };
import sabHistory from "./fixtures/sabnzbd-history.json" with { type: "json" };
import tautulliHistory from "./fixtures/tautulli-history.json" with { type: "json" };
import tautulliRecentlyAddedEpisode from "./fixtures/tautulli-recently-added-episode.json" with { type: "json" };
import overseerrWebhook from "./fixtures/overseerr-webhook.json" with { type: "json" };
import { getAdapter } from "../src/adapters/index.js";
import type { AdapterContext, RuntimeSource } from "../src/types.js";

const now = new Date("2026-06-09T12:30:00Z");

function context(source: RuntimeSource): AdapterContext {
  return { source, ingestMethod: "webhook", now };
}

describe("adapters", () => {
  it("normalizes Sonarr webhook events to media resources", () => {
    const source = sourceFor("sonarr");
    const [event] = getAdapter("sonarr").normalizeWebhook(sonarrWebhook, context(source));

    expect(event.eventType).toBe("imported");
    expect(event.severity).toBe("success");
    expect(event.resource?.canonicalKey).toBe("tvdb:12345");
    expect(event.correlationKey).toBe("sonarr:tvdb:12345");
  });

  it("normalizes Radarr history records with TMDB identity", () => {
    const source = sourceFor("radarr");
    const [event] = getAdapter("radarr").normalizeWebhook(radarrHistory, context(source));

    expect(event.eventType).toBe("grabbed");
    expect(event.resource?.canonicalKey).toBe("tmdb:550");
    expect(event.attributes?.downloadClient).toBe("SABnzbd");
  });

  it("normalizes SABnzbd history records as download resources", () => {
    const source = sourceFor("sabnzbd");
    const [event] = getAdapter("sabnzbd").normalizeWebhook(sabHistory, context(source));

    expect(event.eventType).toBe("download-completed");
    expect(event.severity).toBe("success");
    expect(event.resource?.canonicalKey).toBe("sabnzbd:sabnzbd_nzo_abc123");
  });

  it("normalizes Tautulli history as watched Plex media", () => {
    const source = sourceFor("tautulli");
    const [event] = getAdapter("tautulli").normalizeWebhook(tautulliHistory, context(source));

    expect(event.eventType).toBe("media-watched");
    expect(event.resource?.title).toBe("Example Show - Pilot");
    expect(event.resource?.externalIds?.tmdbId).toBe("12345");
    expect(event.resource?.externalIds?.plexGuid).toBe("plex://episode/abc");
    expect(event.resource?.appRefs?.posterUrl).toBe("/api/thumbnail?sourceKey=tautulli&path=%2Flibrary%2Fmetadata%2F153037%2Fthumb%2F1781006400");
    expect(event.attributes?.plex).toBe(true);
  });

  it("formats Tautulli recently added episodes with episode code and series artwork", () => {
    const source = sourceFor("tautulli");
    const [event] = getAdapter("tautulli").normalizeWebhook(
      { ...tautulliRecentlyAddedEpisode, trigger: "recently_added" },
      context(source),
    );

    expect(event.eventType).toBe("library-new");
    expect(event.message).toBe("S01E03");
    expect(event.resource?.subtitle).toContain("S01E03");
    expect(event.resource?.appRefs?.posterUrl).toBe("/api/thumbnail?sourceKey=tautulli&path=%2Flibrary%2Fmetadata%2F449513%2Fthumb");
  });

  it("normalizes Overseerr request events with TMDB identity", () => {
    const source = sourceFor("overseerr");
    const [event] = getAdapter("overseerr").normalizeWebhook(overseerrWebhook, context(source));

    expect(event.eventType).toBe("media-approved");
    expect(event.severity).toBe("success");
    expect(event.resource?.canonicalKey).toBe("tmdb:550");
    expect(event.attributes?.requestId).toBe("42");
  });

  it("generates stable dedupe keys for repeated observations", () => {
    const source = sourceFor("sonarr");
    const adapter = getAdapter("sonarr");
    const [first] = adapter.normalizeWebhook(sonarrWebhook, context(source));
    const [second] = adapter.normalizeWebhook(sonarrWebhook, context(source));

    expect(first.dedupeKey).toBe(second.dedupeKey);
  });
});

function sourceFor(app: RuntimeSource["app"]): RuntimeSource {
  return {
    key: app,
    app,
    name: app,
    enabled: true,
    baseUrl: "http://localhost",
    apiKey: "api-key",
    ingestToken: "ingest-token",
  };
}
