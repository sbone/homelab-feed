import { loadConfig } from "./config.js";
import { createApp } from "./api/server.js";
import { createDb } from "./db/client.js";
import { syncConfiguredSources } from "./ingest/source-registry.js";
import { formatStartupError } from "./startup-error.js";

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const { db, pool } = createDb(config.databaseUrl);
  const app = createApp(config, db);

  await syncConfiguredSources(db, config);

  const close = async () => {
    await app.close();
    await pool.end();
  };

  process.on("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });

  await app.listen({ host: config.host, port: config.port });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await startServer();
  } catch (error) {
    console.error(formatStartupError(error));
    process.exit(1);
  }
}
