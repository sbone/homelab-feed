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
  filters: {
    sourceKey: "",
    severity: "",
    includeLowValue: false,
  },
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
              <div className="event-meta">
                <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
                <span>{event.source.name}</span>
                <span className={`badge ${event.severity}`}>{event.severity}</span>
                <span>{event.eventType}</span>
              </div>
              <h2>{event.title}</h2>
              {event.message ? <p>{event.message}</p> : null}
              {event.resource ? (
                <div className="resource">
                  {event.resource.title ?? event.resource.canonicalKey}
                  {event.resource.subtitle ? <span>{event.resource.subtitle}</span> : null}
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </section>
    </main>
  );
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
