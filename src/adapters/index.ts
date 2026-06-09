import type { Adapter, AppKind } from "../types.js";
import { overseerrAdapter } from "./overseerr.js";
import { plexAdapter } from "./plex.js";
import { sabnzbdAdapter } from "./sabnzbd.js";
import { createServarrAdapter } from "./servarr.js";

const adapters: Record<AppKind, Adapter> = {
  sonarr: createServarrAdapter("sonarr"),
  radarr: createServarrAdapter("radarr"),
  sabnzbd: sabnzbdAdapter,
  plex: plexAdapter,
  overseerr: overseerrAdapter,
};

export function getAdapter(app: AppKind): Adapter {
  return adapters[app];
}

export { adapters };
