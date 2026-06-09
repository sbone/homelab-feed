import { StrictMode, type Dispatch, useEffect, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, type BackfillSummary, type FeedEvent, type Filters, loadFeed, runBackfill, type Source } from "./api";
import { ThemeToggle } from "./components/theme-toggle";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Select } from "./components/ui/select";
import { Switch } from "./components/ui/switch";
import { ThemeProvider } from "./lib/theme";
import "./styles.css";

interface Model {
  events: FeedEvent[];
  sources: Source[];
  filters: Filters;
  status: "idle" | "loading" | "error";
  error: string | null;
  lastLoadedAt: string | null;
  reloadKey: number;
  adminToken: string;
  syncStatus: "idle" | "running" | "done" | "error";
  syncMessage: string | null;
  syncResults: SyncResult[];
  syncPanelOpen: boolean;
}

interface SyncResult {
  sourceKey: string;
  sourceName: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  message: string;
  insertedEvents?: number;
  normalizedEvents?: number;
  rawPayloads?: number;
}

type Msg =
  | { type: "load_started" }
  | { type: "load_succeeded"; events: FeedEvent[]; sources: Source[] }
  | { type: "load_failed"; error: string }
  | { type: "set_filter"; key: keyof Filters; value: string | boolean }
  | { type: "refresh" }
  | { type: "set_admin_token"; value: string }
  | { type: "sync_started"; results: SyncResult[]; message: string }
  | { type: "sync_source_started"; sourceKey: string }
  | { type: "sync_source_succeeded"; sourceKey: string; summary: BackfillSummary }
  | { type: "sync_source_failed"; sourceKey: string; error: string }
  | { type: "sync_finished"; message: string }
  | { type: "sync_failed"; error: string }
  | { type: "set_sync_panel_open"; value: boolean };

const initialAdminToken = readStoredAdminToken();

const initialModel: Model = {
  events: [],
  sources: [],
  filters: filtersFromUrl(window.location.search),
  status: "idle",
  error: null,
  lastLoadedAt: null,
  reloadKey: 0,
  adminToken: initialAdminToken,
  syncStatus: "idle",
  syncMessage: null,
  syncResults: [],
  syncPanelOpen: readStoredSyncPanelOpen(initialAdminToken),
};

function update(model: Model, msg: Msg): Model {
  switch (msg.type) {
    case "load_started":
      return { ...model, status: "loading", error: null };
    case "load_succeeded":
      return {
        ...model,
        events: msg.events,
        sources: msg.sources,
        status: "idle",
        error: null,
        lastLoadedAt: new Date().toISOString(),
      };
    case "load_failed":
      return { ...model, status: "error", error: msg.error };
    case "set_filter":
      return {
        ...model,
        filters: { ...model.filters, [msg.key]: msg.value },
      };
    case "refresh":
      return { ...model, reloadKey: model.reloadKey + 1 };
    case "set_admin_token":
      return { ...model, adminToken: msg.value };
    case "sync_started":
      return { ...model, syncStatus: "running", syncMessage: msg.message, syncResults: msg.results, syncPanelOpen: true };
    case "sync_source_started":
      return {
        ...model,
        syncResults: updateSyncResult(model.syncResults, msg.sourceKey, {
          status: "running",
          message: "Running backfill...",
        }),
      };
    case "sync_source_succeeded":
      return {
        ...model,
        syncResults: updateSyncResult(model.syncResults, msg.sourceKey, {
          status: "succeeded",
          message: `${msg.summary.insertedEvents} new / ${msg.summary.normalizedEvents} seen`,
          insertedEvents: msg.summary.insertedEvents,
          normalizedEvents: msg.summary.normalizedEvents,
          rawPayloads: msg.summary.rawPayloads,
        }),
      };
    case "sync_source_failed":
      return {
        ...model,
        syncResults: updateSyncResult(model.syncResults, msg.sourceKey, {
          status: "failed",
          message: msg.error,
        }),
      };
    case "sync_finished":
      return { ...model, syncStatus: "done", syncMessage: msg.message };
    case "sync_failed":
      return { ...model, syncStatus: "error", syncMessage: msg.error, syncPanelOpen: true };
    case "set_sync_panel_open":
      return { ...model, syncPanelOpen: msg.value };
  }
}

function App() {
  const [model, dispatch] = useReducer(update, initialModel);

  useEffect(() => {
    syncUrl(model.filters);
  }, [model.filters]);

  useEffect(() => {
    writeStoredAdminToken(model.adminToken);
  }, [model.adminToken]);

  useEffect(() => {
    writeStoredSyncPanelOpen(model.syncPanelOpen);
  }, [model.syncPanelOpen]);

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: "load_started" });
    loadFeed(model.filters)
      .then((result) => {
        if (!cancelled) {
          dispatch({ type: "load_succeeded", events: result.events, sources: result.sources });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          dispatch({ type: "load_failed", error: error instanceof Error ? error.message : "Unknown error" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [model.filters, model.reloadKey]);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Homelab Feed</h1>
          <p>{summaryText(model)}</p>
        </div>
        <div className="topbar-actions">
          <ThemeToggle />
          <Button
            type="button"
            variant="outline"
            onClick={() => dispatch({ type: "set_sync_panel_open", value: !model.syncPanelOpen })}
          >
            {model.syncPanelOpen ? "Hide sync" : "Sync details"}
          </Button>
          <Button
            type="button"
            onClick={() => void refreshFromSources(model, dispatch)}
            disabled={model.status === "loading" || model.syncStatus === "running"}
          >
            {model.syncStatus === "running" ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </header>

      <section className="toolbar" aria-label="Feed filters">
        <label>
          <span>Source</span>
          <Select
            value={model.filters.sourceKey}
            onChange={(event) => dispatch({ type: "set_filter", key: "sourceKey", value: event.target.value })}
          >
            <option value="">All sources</option>
            {model.sources.map((source) => (
              <option key={source.key} value={source.key}>
                {source.name}
              </option>
            ))}
          </Select>
        </label>

        <label>
          <span>Severity</span>
          <Select
            value={model.filters.severity}
            onChange={(event) => dispatch({ type: "set_filter", key: "severity", value: event.target.value })}
          >
            <option value="">All severities</option>
            <option value="success">Success</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
          </Select>
        </label>

        <Switch
          label="Low-value events"
          checked={model.filters.includeLowValue}
          onChange={(event) => dispatch({ type: "set_filter", key: "includeLowValue", value: event.target.checked })}
        />
      </section>

      {model.syncPanelOpen ? (
        <section className="sync-panel" aria-label="Manual source refresh">
          <div className="sync-panel-head">
            <label className="token-field">
              <span>Admin token</span>
              <Input
                type="password"
                value={model.adminToken}
                placeholder="Required for manual refresh"
                autoComplete="off"
                onChange={(event) => dispatch({ type: "set_admin_token", value: event.target.value })}
              />
            </label>
            <Button type="button" variant="ghost" size="sm" onClick={() => dispatch({ type: "set_sync_panel_open", value: false })}>
              Hide
            </Button>
          </div>
          <div className="sync-copy">
            <strong>{model.syncMessage ?? "Manual refresh runs source backfills, then reloads the feed."}</strong>
            <span>Token is stored in this browser only.</span>
          </div>
          {model.syncResults.length > 0 ? (
            <div className="sync-results" aria-live="polite">
              {model.syncResults.map((result) => (
                <div className="sync-result" key={result.sourceKey}>
                  <span className={`status-dot ${result.status}`} />
                  <span>{result.sourceName}</span>
                  <span>{result.message}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {model.status === "error" ? <div className="notice error">{model.error}</div> : null}
      {model.status === "loading" && model.events.length === 0 ? <div className="notice">Loading feed...</div> : null}

      <section className="timeline" aria-label="Activity timeline">
        {model.events.map((event) => (
          <article className="event" key={event.id}>
            <div className={`rail ${event.severity}`} />
            <div className="event-main">
              {posterUrl(event) ? (
                <img className="poster" src={posterUrl(event)} alt="" loading="lazy" />
              ) : null}
              <div className="event-copy">
                <div className="event-meta">
                  <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
                  <Badge className={`provider-pill ${providerClass(event.source.app)}`}>{event.source.name}</Badge>
                  <Badge className={`severity-badge ${event.severity}`}>{event.severity}</Badge>
                  <span>{event.eventType}</span>
                </div>
                <h2>{displayTitle(event)}</h2>
                <div className="details">
                  {event.resource?.subtitle ? <span>{event.resource.subtitle}</span> : null}
                  {actorName(event) ? (
                    <span>{event.attributes.requestedBy ? "Requested by" : "User"} {actorName(event)}</span>
                  ) : null}
                </div>
                {event.message && event.message !== displayTitle(event) ? <p>{event.message}</p> : null}
                {event.resource ? <ResourceLinks event={event} /> : null}
              </div>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

async function refreshFromSources(model: Model, dispatch: Dispatch<Msg>): Promise<void> {
  const adminToken = model.adminToken.trim();
  if (!adminToken) {
    dispatch({ type: "sync_failed", error: "Enter ADMIN_TOKEN to run manual backfills." });
    return;
  }

  const initialResults = model.sources.map((source) => ({
    sourceKey: source.key,
    sourceName: source.name,
    status: supportsBackfill(source) ? "pending" : "skipped",
    message: supportsBackfill(source) ? "Waiting" : "Webhook-only in this version",
  })) satisfies SyncResult[];
  const runnableSources = model.sources.filter(supportsBackfill);

  if (runnableSources.length === 0) {
    dispatch({ type: "sync_failed", error: "No enabled sources support manual backfill." });
    return;
  }

  dispatch({
    type: "sync_started",
    results: initialResults,
    message: `Running ${runnableSources.length} source backfill${runnableSources.length === 1 ? "" : "s"}...`,
  });

  let failures = 0;
  let insertedEvents = 0;

  for (const source of runnableSources) {
    dispatch({ type: "sync_source_started", sourceKey: source.key });

    try {
      const summary = await runBackfill(source.key, adminToken);
      insertedEvents += summary.insertedEvents;
      dispatch({ type: "sync_source_succeeded", sourceKey: source.key, summary });
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : "Unknown sync error";
      dispatch({ type: "sync_source_failed", sourceKey: source.key, error: message });

      if (error instanceof ApiError && error.status === 401) {
        dispatch({ type: "sync_failed", error: "ADMIN_TOKEN was rejected. Check the token and try again." });
        return;
      }
    }
  }

  dispatch({
    type: "sync_finished",
    message:
      failures > 0
        ? `Refresh finished with ${failures} failure${failures === 1 ? "" : "s"}.`
        : `Refresh finished. ${insertedEvents} new event${insertedEvents === 1 ? "" : "s"} inserted.`,
  });
  dispatch({ type: "refresh" });
}

function supportsBackfill(source: Source): boolean {
  return source.enabled && source.capabilities.some((capability) => capability === "pollHistory" || capability === "pollStatus");
}

function updateSyncResult(results: SyncResult[], sourceKey: string, patch: Partial<SyncResult>): SyncResult[] {
  return results.map((result) => (result.sourceKey === sourceKey ? { ...result, ...patch } : result));
}

function filtersFromUrl(search: string): Filters {
  const params = new URLSearchParams(search);
  const severity = params.get("severity") ?? "";

  return {
    sourceKey: params.get("source") ?? "",
    severity: ["success", "info", "warning", "error"].includes(severity) ? severity : "",
    includeLowValue: ["1", "true", "yes"].includes((params.get("lowValue") ?? "").toLowerCase()),
  };
}

function syncUrl(filters: Filters): void {
  const params = new URLSearchParams(window.location.search);
  setOptionalParam(params, "source", filters.sourceKey);
  setOptionalParam(params, "severity", filters.severity);

  if (filters.includeLowValue) {
    params.set("lowValue", "1");
  } else {
    params.delete("lowValue");
  }

  const nextSearch = params.toString();
  const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  if (nextUrl !== currentUrl) {
    window.history.replaceState(null, "", nextUrl);
  }
}

function setOptionalParam(params: URLSearchParams, key: string, value: string): void {
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
}

function readStoredAdminToken(): string {
  return window.localStorage.getItem("homelab-feed-admin-token") ?? "";
}

function writeStoredAdminToken(value: string): void {
  const trimmed = value.trim();
  if (trimmed) {
    window.localStorage.setItem("homelab-feed-admin-token", trimmed);
  } else {
    window.localStorage.removeItem("homelab-feed-admin-token");
  }
}

function readStoredSyncPanelOpen(adminToken: string): boolean {
  const stored = window.localStorage.getItem("homelab-feed-sync-panel-open");
  if (stored === "true" || stored === "false") {
    return stored === "true";
  }

  return !adminToken;
}

function writeStoredSyncPanelOpen(value: boolean): void {
  window.localStorage.setItem("homelab-feed-sync-panel-open", String(value));
}

function providerClass(app: string): string {
  return `provider-${app.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function ResourceLinks({ event }: { event: FeedEvent }) {
  const links = [
    ["TMDB", stringValue(event.resource?.appRefs.tmdbUrl)],
    ["IMDb", stringValue(event.resource?.appRefs.imdbUrl)],
    ["Metacritic", stringValue(event.resource?.appRefs.metacriticUrl)],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  if (links.length === 0) {
    return null;
  }

  return (
    <div className="resource-links">
      {links.map(([label, href]) => (
        <a key={label} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>
      ))}
    </div>
  );
}

function displayTitle(event: FeedEvent): string {
  return event.resource?.title ?? event.title;
}

function actorName(event: FeedEvent): string | undefined {
  return stringValue(event.attributes.requestedBy?.displayName) ?? stringValue(event.attributes.user);
}

function posterUrl(event: FeedEvent): string | undefined {
  return stringValue(event.resource?.appRefs.posterUrl);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function summaryText(model: Model): string {
  if (model.status === "loading" && model.events.length > 0) {
    return `Refreshing ${model.events.length} events`;
  }
  if (model.lastLoadedAt) {
    return `${model.events.length} events loaded at ${formatClock(model.lastLoadedAt)}`;
  }
  return "Latest normalized activity from your media stack";
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatClock(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
