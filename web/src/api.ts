export type Severity = "success" | "info" | "warning" | "error";

export interface Source {
  key: string;
  app: string;
  name: string;
  enabled: boolean;
}

export interface FeedEvent {
  id: string;
  occurredAt: string;
  severity: Severity;
  eventType: string;
  title: string;
  message: string | null;
  visibility: "default" | "low_value";
  source: {
    key: string;
    app: string;
    name: string;
  };
  attributes: {
    requestedBy?: {
      id?: string | number;
      displayName?: string;
    };
  } & Record<string, unknown>;
  resource: {
    canonicalKey: string;
    title: string | null;
    subtitle: string | null;
    externalIds: Record<string, unknown>;
    appRefs: {
      posterUrl?: string;
      tmdbUrl?: string;
      imdbUrl?: string;
      metacriticUrl?: string;
      year?: string;
      mediaType?: string;
    } & Record<string, unknown>;
  } | null;
}

export interface Filters {
  sourceKey: string;
  severity: string;
  includeLowValue: boolean;
}

interface EventsResponse {
  events: FeedEvent[];
  nextCursor?: string;
}

interface SourcesResponse {
  sources: Source[];
}

export async function loadFeed(filters: Filters): Promise<{ events: FeedEvent[]; sources: Source[] }> {
  const [events, sources] = await Promise.all([
    getJson<EventsResponse>(eventUrl(filters)),
    getJson<SourcesResponse>("/api/sources"),
  ]);
  return { events: events.events, sources: sources.sources };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
  }
  return (await response.json()) as T;
}

function eventUrl(filters: Filters): string {
  const params = new URLSearchParams({ limit: "100" });
  if (filters.sourceKey) {
    params.set("sourceKey", filters.sourceKey);
  }
  if (filters.severity) {
    params.set("severity", filters.severity);
  }
  if (filters.includeLowValue) {
    params.set("includeLowValue", "true");
  }
  return `/api/events?${params.toString()}`;
}
