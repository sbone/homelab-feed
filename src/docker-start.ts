import { runMigrations } from "./db/migrate.js";
import { startServer } from "./index.js";
import { formatStartupError } from "./startup-error.js";

try {
  await runMigrations();
  await startServer();
} catch (error) {
  console.error(formatStartupError(error));
  process.exit(1);
}
