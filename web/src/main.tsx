import { StrictMode, useEffect, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { type FeedEvent, type Filters, loadFeed, type Source } from "./api";
import "./styles.css";

interface Model {
  events: FeedEvent[];
  sources: Source[];
  filters: Filters;
  status: "idle" | "loading" | "error";
  error: string | null;
  lastLoadedAt: string | null;
  reloadKey: number;
}

type Msg =
  | { type: "load_started" }
  | { type: "load_succeeded"; events: FeedEvent[]; sources: Source[] }
  | { type: "load_failed"; error: string }
  | { type: "set_filter"; key: keyof Filters; value: string | boolean }
  | { type: "refresh" };

const initialModel: Model = {
  events: [],
  sources: [],
  filters: filtersFromUrl(window.location.search),
  status: "idle",
  error: null,
  lastLoadedAt: null,
  reloadKey: 0,
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
  }
}

function App() {
  const [model, dispatch] = useReducer(update, initialModel);

  useEffect(() => {
    syncUrl(model.filters);
  }, [model.filters]);

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
        <button
          type="button"
          className="button"
          onClick={() => dispatch({ type: "refresh" })}
          disabled={model.status === "loading"}
        >
          Refresh
        </button>
      </header>

      <section className="toolbar" aria-label="Feed filters">
        <label>
          <span>Source</span>
          <select
            value={model.filters.sourceKey}
            onChange={(event) => dispatch({ type: "set_filter", key: "sourceKey", value: event.target.value })}
          >
            <option value="">All sources</option>
            {model.sources.map((source) => (
              <option key={source.key} value={source.key}>
                {source.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Severity</span>
          <select
            value={model.filters.severity}
            onChange={(event) => dispatch({ type: "set_filter", key: "severity", value: event.target.value })}
          >
            <option value="">All severities</option>
            <option value="success">Success</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
          </select>
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={model.filters.includeLowValue}
            onChange={(event) =>
              dispatch({ type: "set_filter", key: "includeLowValue", value: event.target.checked })
            }
          />
          <span>Low-value events</span>
        </label>
      </section>

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
                  <span className={`provider-pill ${providerClass(event.source.app)}`}>{event.source.name}</span>
                  <span className={`badge ${event.severity}`}>{event.severity}</span>
                  <span>{event.eventType}</span>
                </div>
                <h2>{displayTitle(event)}</h2>
                <div className="details">
                  {event.resource?.subtitle ? <span>{event.resource.subtitle}</span> : null}
                  {requesterName(event) ? <span>Requested by {requesterName(event)}</span> : null}
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

function requesterName(event: FeedEvent): string | undefined {
  return event.attributes.requestedBy?.displayName;
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
    <App />
  </StrictMode>,
);
