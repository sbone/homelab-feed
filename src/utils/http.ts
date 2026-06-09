import type { RuntimeSource } from "../types.js";

export async function fetchJson<T>(url: URL, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(15_000),
      headers: {
        accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    throw new Error(formatFetchFailure(url, error), { cause: error });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${url.toString()}: ${body.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

function formatFetchFailure(url: URL, error: unknown): string {
  const cause = error && typeof error === "object" && "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : undefined;
  const name = error instanceof Error ? error.name : undefined;

  if (name === "TimeoutError" || code === "ETIMEDOUT") {
    return `Could not reach ${url.origin}: request timed out after 15s`;
  }
  if (code === "ENOTFOUND") {
    return `Could not resolve ${url.hostname}. Check the source baseUrl or Docker DNS/extra_hosts settings.`;
  }
  if (code === "ECONNREFUSED") {
    return `Connection refused by ${url.origin}. Check that the app is running and the port is correct.`;
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return `Network cannot reach ${url.origin}. Check LAN/Tailscale routing from the app container.`;
  }

  const detail = error instanceof Error ? error.message : "unknown fetch error";
  return `Could not reach ${url.origin}: ${detail}`;
}

export function sourceUrl(source: RuntimeSource, path: string): URL {
  if (!source.baseUrl) {
    throw new Error(`Source ${source.key} does not have a baseUrl`);
  }

  const base = source.baseUrl.endsWith("/") ? source.baseUrl : `${source.baseUrl}/`;
  return new URL(path.replace(/^\//, ""), base);
}

export function withApiKey(url: URL, source: RuntimeSource, param = "apikey"): URL {
  if (!source.apiKey) {
    throw new Error(`Source ${source.key} is missing API key from ${source.apiKeyEnv ?? "apiKeyEnv"}`);
  }

  url.searchParams.set(param, source.apiKey);
  return url;
}
