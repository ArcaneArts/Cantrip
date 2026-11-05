import { useCallback, useState } from "react";
import { scopedClientStorageKey } from "@/lib/client-session";
import type { ModelsSettingsTab } from "./models-settings-state";

const KEY = "cantrip.models-settings-tab.v1";
function read(key: string): ModelsSettingsTab {
  try {
    const value = window.localStorage.getItem(key);
    return value === "general" ||
      (value?.startsWith("provider:") && value.length > 9)
      ? (value as ModelsSettingsTab)
      : "general";
  } catch {
    return "general";
  }
}

/** Provider IDs survive renames; the storage scope follows server and owner. */
export function useModelsSettingsTab() {
  const key = scopedClientStorageKey(KEY);
  const [selection, setSelection] = useState(() => ({ key, tab: read(key) }));
  const tab = selection.key === key ? selection.tab : read(key);
  const setTab = useCallback(
    (tab: ModelsSettingsTab) => {
      try {
        window.localStorage.setItem(key, tab);
      } catch {
        /* Session-only when storage is unavailable. */
      }
      setSelection({ key, tab });
    },
    [key],
  );
  return [tab, setTab] as const;
}
