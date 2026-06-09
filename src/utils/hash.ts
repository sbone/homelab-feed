import { createHash } from "node:crypto";
import { stableJson } from "./stable-json.js";

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

export function compactKey(...parts: Array<string | number | boolean | null | undefined>): string {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).length > 0)
    .map((part) => String(part).trim().toLowerCase().replace(/\s+/g, "-"))
    .join(":");
}
