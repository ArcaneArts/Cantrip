const STORAGE_KEY = "cantrip.remote-desktop-application-icons.v1";
const MAX_ENTRIES = 160;
const MAX_STORED_CHARACTERS = 3_000_000;
const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60_000;

interface StoredIcon {
  dataUrl: string | null;
  lastUsed: number;
}

const icons = new Map<string, StoredIcon>();
let hydrated = false;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const localStorage = storage();
  if (!localStorage) return;
  try {
    const parsed = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "{}",
    ) as Record<string, StoredIcon>;
    for (const [key, value] of Object.entries(parsed)) {
      if (
        value &&
        (value.dataUrl === null ||
          (typeof value.dataUrl === "string" &&
            value.dataUrl.startsWith("data:image/png;base64,"))) &&
        Number.isFinite(value.lastUsed)
      ) {
        icons.set(key, value);
      }
    }
  } catch {
    // A stale or truncated browser cache is safe to discard.
  }
}

function persist(): void {
  const localStorage = storage();
  if (!localStorage) return;
  const ordered = [...icons.entries()].sort(
    ([, left], [, right]) => right.lastUsed - left.lastUsed,
  );
  const retained = new Map<string, StoredIcon>();
  let characters = 2;
  for (const [key, value] of ordered) {
    const entrySize = key.length + (value.dataUrl?.length ?? 4) + 40;
    if (
      retained.size >= MAX_ENTRIES ||
      characters + entrySize > MAX_STORED_CHARACTERS
    ) {
      continue;
    }
    retained.set(key, value);
    characters += entrySize;
  }
  icons.clear();
  for (const [key, value] of retained) icons.set(key, value);
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(icons)),
    );
  } catch {
    // Quota and privacy-mode failures only disable persistence for this write.
  }
}

function namespacedKey(workerId: string, iconKey: string): string {
  return `${workerId}:${iconKey}`;
}

export function cachedRemoteDesktopIcon(
  workerId: string,
  iconKey: string,
): string | null | undefined {
  hydrate();
  const key = namespacedKey(workerId, iconKey);
  const entry = icons.get(key);
  if (!entry) return undefined;
  if (
    entry.dataUrl === null &&
    Date.now() - entry.lastUsed > NEGATIVE_CACHE_TTL_MS
  ) {
    icons.delete(key);
    persist();
    return undefined;
  }
  if (entry.dataUrl !== null) entry.lastUsed = Date.now();
  return entry.dataUrl;
}

export function cacheRemoteDesktopIcon(
  workerId: string,
  iconKey: string,
  base64Data: string | null,
): string | null {
  hydrate();
  const dataUrl = base64Data ? `data:image/png;base64,${base64Data}` : null;
  icons.set(namespacedKey(workerId, iconKey), {
    dataUrl,
    lastUsed: Date.now(),
  });
  persist();
  return dataUrl;
}

export function cacheRemoteDesktopIcons(
  workerId: string,
  entries: Array<{ key: string; data: string | null }>,
): Record<string, string | null> {
  hydrate();
  const resolved: Record<string, string | null> = {};
  for (const entry of entries) {
    const dataUrl = entry.data ? `data:image/png;base64,${entry.data}` : null;
    icons.set(namespacedKey(workerId, entry.key), {
      dataUrl,
      lastUsed: Date.now(),
    });
    resolved[entry.key] = dataUrl;
  }
  persist();
  return resolved;
}

export function resetRemoteDesktopIconMemoryCacheForTests(): void {
  icons.clear();
  hydrated = false;
}
