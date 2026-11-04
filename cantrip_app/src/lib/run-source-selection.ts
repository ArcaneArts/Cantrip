import {
  cantripOsRunSelectionSchema,
  type CantripOsRunSelection,
} from "@cantrip/protocol";
import { scopedClientStorageKey } from "./client-session";

export const RUN_SOURCE_EVENT = "cantrip-run-source-changed";
export function readRunSource(projectId: string): string {
  return (
    window.localStorage.getItem(
      scopedClientStorageKey(`cantrip:run-source:${projectId}`),
    ) ?? "host"
  );
}
export function writeRunSource(
  projectId: string,
  selection: CantripOsRunSelection | null,
) {
  window.localStorage.setItem(
    scopedClientStorageKey(`cantrip:run-source:${projectId}`),
    selection ? JSON.stringify(selection) : "host",
  );
  window.dispatchEvent(new Event(RUN_SOURCE_EVENT));
}
export function parseRunSource(encoded: string) {
  if (encoded === "host") return null;
  const parsed = cantripOsRunSelectionSchema.safeParse(
    (() => {
      try {
        return JSON.parse(encoded);
      } catch {
        return undefined;
      }
    })(),
  );
  return parsed.success && parsed.data.kind === "binding"
    ? parsed.data
    : undefined;
}
