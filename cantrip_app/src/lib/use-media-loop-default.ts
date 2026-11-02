import { useMemo } from "react";
import type { ExplorerMediaKind } from "@cantrip/protocol";
import { readEditorBoolean } from "./editor-preferences";

/** Take a fresh default for each source without resetting ongoing playback. */
export function useMediaLoopDefault(
  kind: ExplorerMediaKind,
  source: string | null,
): boolean {
  return useMemo(
    () => kind !== "image" && readEditorBoolean(`${kind}-loop`),
    [kind, source],
  );
}
