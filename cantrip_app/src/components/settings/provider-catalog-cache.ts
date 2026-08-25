import {
  providerModelCatalogResultSchema,
  type ProviderModelCatalogResult,
} from "@cantrip/protocol";

import { scopedClientStorageKey } from "@/lib/client-session";

const STORAGE_KEY = "cantrip.provider-model-catalogs.v1";
const CACHE_VERSION = 1;
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60_000;
const MAX_CACHE_ENTRIES = 8;
const MAX_STORED_CHARACTERS = 3_000_000;

interface StoredProviderCatalog {
  cachedAt: number;
  catalog: ProviderModelCatalogResult;
  providerId: string;
  workerId: string | null;
}

interface StoredProviderCatalogs {
  entries: StoredProviderCatalog[];
  version: typeof CACHE_VERSION;
}

interface HydratedProviderCatalogs {
  entries: StoredProviderCatalog[];
  persistedValue: string | null;
  storageKey: string;
}

const hydratedCatalogs = new WeakMap<Storage, HydratedProviderCatalogs>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parseEntries(
  value: string | null,
  now = Date.now(),
): StoredProviderCatalog[] {
  try {
    const parsed = JSON.parse(
      value ?? "null",
    ) as Partial<StoredProviderCatalogs> | null;
    if (parsed?.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
      return [];
    }
    return parsed.entries.flatMap((entry) => {
      if (
        !entry ||
        typeof entry.providerId !== "string" ||
        (entry.workerId !== null && typeof entry.workerId !== "string") ||
        !Number.isFinite(entry.cachedAt) ||
        now - entry.cachedAt > MAX_CACHE_AGE_MS
      ) {
        return [];
      }
      const catalog = providerModelCatalogResultSchema.safeParse(entry.catalog);
      if (!catalog.success || catalog.data.providerId !== entry.providerId) {
        return [];
      }
      return [{ ...entry, catalog: catalog.data }];
    });
  } catch {
    return [];
  }
}

function hydratedEntries(
  localStorage: Storage,
  now = Date.now(),
): HydratedProviderCatalogs {
  const storageKey = scopedClientStorageKey(STORAGE_KEY);
  const existing = hydratedCatalogs.get(localStorage);
  if (existing?.storageKey === storageKey) return existing;

  let persistedValue: string | null = null;
  try {
    persistedValue = localStorage.getItem(storageKey);
  } catch {
    // Privacy-mode failures only disable persistence for this hydration.
  }
  const hydrated = {
    entries: parseEntries(persistedValue, now),
    persistedValue,
    storageKey,
  };
  hydratedCatalogs.set(localStorage, hydrated);
  return hydrated;
}

function activeEntries(
  hydrated: HydratedProviderCatalogs,
  now = Date.now(),
): StoredProviderCatalog[] {
  return hydrated.entries.filter(
    (entry) => now - entry.cachedAt <= MAX_CACHE_AGE_MS,
  );
}

function sameScope(
  entry: Pick<StoredProviderCatalog, "providerId" | "workerId">,
  providerId: string,
  workerId: string | null,
) {
  return entry.providerId === providerId && entry.workerId === workerId;
}

export function cachedProviderModelCatalog(
  providerId: string,
  workerId: string | null,
): ProviderModelCatalogResult | undefined {
  const localStorage = storage();
  if (!localStorage) return undefined;
  return activeEntries(hydratedEntries(localStorage)).find((entry) =>
    sameScope(entry, providerId, workerId),
  )?.catalog;
}

export function cacheProviderModelCatalog(
  providerId: string,
  workerId: string | null,
  value: ProviderModelCatalogResult,
): void {
  const localStorage = storage();
  if (!localStorage) return;
  const catalog = providerModelCatalogResultSchema.safeParse(value);
  if (!catalog.success || catalog.data.providerId !== providerId) return;

  const now = Date.now();
  const hydrated = hydratedEntries(localStorage, now);
  const candidates: StoredProviderCatalog[] = [
    { cachedAt: now, catalog: catalog.data, providerId, workerId },
    ...activeEntries(hydrated, now).filter(
      (entry) => !sameScope(entry, providerId, workerId),
    ),
  ];
  const entries: StoredProviderCatalog[] = [];
  let storedCharacters = 0;
  for (const entry of candidates) {
    if (entries.length >= MAX_CACHE_ENTRIES) break;
    const entryCharacters = JSON.stringify(entry).length;
    if (storedCharacters + entryCharacters > MAX_STORED_CHARACTERS) continue;
    entries.push(entry);
    storedCharacters += entryCharacters;
  }
  hydrated.entries = entries;
  const persistedValue = JSON.stringify({ entries, version: CACHE_VERSION });
  if (persistedValue === hydrated.persistedValue) return;
  try {
    localStorage.setItem(hydrated.storageKey, persistedValue);
    hydrated.persistedValue = persistedValue;
  } catch {
    // Quota and privacy-mode failures only disable persistence for this write.
  }
}
