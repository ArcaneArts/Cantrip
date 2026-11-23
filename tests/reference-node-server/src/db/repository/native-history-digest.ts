import { createHash } from "node:crypto";

// JSONB object key ordering must not change a persisted payload's identity.
// Callers validate JSON through the wire schema first; arrays remain ordered.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function nativeHistoryPayloadDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
