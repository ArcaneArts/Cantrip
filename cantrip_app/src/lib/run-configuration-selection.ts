const STORAGE_NAME = "cantrip:run-configuration-selection";

export interface RunConfigurationSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function selectionStorageKey(scopeKey: (name: string) => string): string {
  return scopeKey(STORAGE_NAME);
}

function readSelections(
  storage: RunConfigurationSelectionStorage,
  key: string,
): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          entry[0].length > 0 &&
          typeof entry[1] === "string" &&
          entry[1].length > 0,
      ),
    );
  } catch {
    return {};
  }
}

export function readRunConfigurationSelection(
  projectId: string,
  scopeKey: (name: string) => string,
  storage: RunConfigurationSelectionStorage | null = typeof window ===
  "undefined"
    ? null
    : window.localStorage,
): string | null {
  if (!storage) return null;
  return (
    readSelections(storage, selectionStorageKey(scopeKey))[projectId] ?? null
  );
}

export function writeRunConfigurationSelection(
  projectId: string,
  configurationId: string | null,
  scopeKey: (name: string) => string,
  storage: RunConfigurationSelectionStorage | null = typeof window ===
  "undefined"
    ? null
    : window.localStorage,
): void {
  if (!storage) return;
  const key = selectionStorageKey(scopeKey);
  const selections = readSelections(storage, key);
  if (configurationId) selections[projectId] = configurationId;
  else delete selections[projectId];
  storage.setItem(key, JSON.stringify(selections));
}

export function reconcileRunConfigurationSelection(
  preferredId: string | null,
  availableIds: readonly string[],
): string | null {
  if (preferredId && availableIds.includes(preferredId)) return preferredId;
  return availableIds[0] ?? null;
}
