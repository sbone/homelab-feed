import { ConfigError } from "./config.js";

export function formatStartupError(error: unknown): string {
  if (error instanceof ConfigError) {
    return `Configuration error: ${error.message}`;
  }

  if (isConnectionRefused(error)) {
    return [
      "Database connection failed: Postgres refused the connection.",
      "If you are using Docker Compose, run `docker compose up --build`.",
      "If you are running Node directly, check that DATABASE_URL points to a running Postgres instance.",
    ].join(" ");
  }

  if (error instanceof Error) {
    return `Startup failed: ${error.message}`;
  }

  return "Startup failed with an unknown error.";
}

function isConnectionRefused(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ECONNREFUSED",
  );
}
