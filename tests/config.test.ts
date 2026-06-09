import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  it("resolves source secrets from referenced env names", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      ADMIN_TOKEN: "0123456789abcdef",
      HOMELAB_FEED_SOURCES: JSON.stringify([
        {
          key: "sonarr",
          name: "Sonarr",
          app: "sonarr",
          apiKeyEnv: "SONARR_API_KEY",
          ingestTokenEnv: "SONARR_INGEST_TOKEN",
        },
      ]),
      SONARR_API_KEY: "api-secret",
      SONARR_INGEST_TOKEN: "ingest-secret",
    });

    expect(config.sources[0]?.apiKey).toBe("api-secret");
    expect(config.sources[0]?.ingestToken).toBe("ingest-secret");
  });

  it("reports missing source secrets with the source key and env var name", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        ADMIN_TOKEN: "0123456789abcdef",
        HOMELAB_FEED_SOURCES: JSON.stringify([
          {
            key: "sonarr",
            name: "Sonarr",
            app: "sonarr",
            apiKeyEnv: "SONARR_API_KEY",
          },
        ]),
      }),
    ).toThrow("sonarr: SONARR_API_KEY");
  });
});
