# Homelab Feed

A local API-only activity feed collector for homelab media apps: Sonarr, Radarr, SABnzbd, Plex, and Overseerr.

The collector stores immutable raw payloads and normalized feed events in Postgres. App-specific adapters handle vendor payloads, but the database and query API stay generic enough for timeline views, filtering, rollups, and debouncing.

## Recommended: Docker Compose

This is the lowest-confusion way to run the collector. Docker runs both the API and Postgres, keeps the database private to Docker, and exposes only the app on port `3000`.

```bash
cp .env.example .env
cp config/sources.example.json config/sources.json
docker compose up --build
```

Then check:

```bash
curl http://localhost:3000/healthz
```

Before first run, replace `ADMIN_TOKEN` in `.env` with a long random value:

```bash
openssl rand -base64 32
```

Fill in the app API keys and ingest tokens in `.env`. Edit `config/sources.json` for app URLs. Both `.env` and `config/sources.json` are ignored by git.

The Compose setup uses:

- `.env` for secrets and top-level app settings
- `config/sources.json` for app URLs and env var names
- `db:5432` inside Docker for Postgres
- `localhost:3000` from your Mac/browser for this app

If Sonarr/Radarr/SABnzbd run directly on your Mac, use `host.docker.internal` in `config/sources.json`. If they run on another machine, use that machine's LAN IP or hostname.

If a hostname works on your Mac but not inside Docker, add a local ignored `docker-compose.override.yml`:

```yaml
services:
  app:
    extra_hosts:
      - "home:100.x.y.z"
```

## Local Node

- Node.js 22+
- pnpm 9+
- Postgres reachable through `DATABASE_URL`

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm server
```

`HOMELAB_FEED_SOURCES` is a JSON array or an `@/absolute/path/to/sources.json` reference. Source entries reference secret environment variable names, for example `apiKeyEnv`, rather than containing secrets directly.

## Mental Model

From your Mac, use published ports like `localhost:3000`. From one container to another, use Compose service names like `db:5432`. Inside a container, `localhost` means that same container.

## API

- `GET /healthz`
- `POST /ingest/:sourceKey/:adapter`
- `GET /api/events`
- `GET /api/resources`
- `GET /api/sources`
- `POST /api/sync/:sourceKey/backfill`

Ingest endpoints require the source-specific bearer token. Admin endpoints require `ADMIN_TOKEN`.

Backfill examples:

```bash
ADMIN_TOKEN="$(sed -n 's/^ADMIN_TOKEN=//p' .env)"

curl -X POST http://localhost:3000/api/sync/sonarr/backfill \
  -H "Authorization: Bearer ${ADMIN_TOKEN}"

curl -s "http://localhost:3000/api/events?limit=10" | jq
```

Backfill-capable sources in v1 are Sonarr, Radarr, SABnzbd, and Overseerr. Plex is webhook-only.

## Source Notes

- Sonarr/Radarr use the shared Servarr adapter for webhooks and `/api/v3/history` backfill.
- SABnzbd uses `mode=history` and `mode=queue`, with optional notification-script ingestion.
- Plex is webhook-only in v1 and accepts multipart webhook payloads.
- Overseerr accepts custom webhook JSON and can backfill request state from its API.

## Implementation Notes

- Raw payloads are stored for audit/debug, but `/api/events` returns normalized events only.
- Noisy events can be marked `low_value`; `/api/events` hides them unless `includeLowValue=true`.
- Query filters include `app`, `sourceKey`, `severity`, `eventType`, `resource`, `from`, `to`, `cursor`, and `grouped`.
- Startup and upstream connection failures are formatted to call out missing config, refused connections, DNS failures, and timeouts.
