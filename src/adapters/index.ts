import type { Adapter, AppKind } from "../types.js";
import { overseerrAdapter } from "./overseerr.js";
import { sabnzbdAdapter } from "./sabnzbd.js";
import { createServarrAdapter } from "./servarr.js";
import { tautulliAdapter } from "./tautulli.js";

const adapters: Record<AppKind, Adapter> = {
  sonarr: createServarrAdapter("sonarr"),
  radarr: createServarrAdapter("radarr"),
  sabnzbd: sabnzbdAdapter,
  tautulli: tautulliAdapter,
  overseerr: overseerrAdapter,
};

export function getAdapter(app: AppKind): Adapter {
  return adapters[app];
}

export { adapters };
