import type {
  ModelProviderSummary,
  ProviderCatalogSyncState,
  ProviderModelAvailability,
  ProviderModelCatalogEntry,
  ProviderModelCatalogResult,
} from "@cantrip/protocol";

export type CatalogDisplayStatus =
  "current" | "failed" | "manual" | "refreshing" | "stale" | "unknown";

export function providerSupportsCatalog(provider: ModelProviderSummary) {
  if (provider.kind === "ollama" || provider.kind === "chatgpt") return true;
  try {
    return new URL(provider.baseUrl).hostname.toLowerCase() === "openrouter.ai";
  } catch {
    return false;
  }
}

export function catalogScopesForWorker(
  syncStates: ProviderCatalogSyncState[],
  workerId: string | null,
) {
  return syncStates.filter(
    (state) => state.workerId === null || state.workerId === workerId,
  );
}

export function catalogAvailabilityForWorker(
  availability: ProviderModelAvailability[],
  workerId: string | null,
) {
  return availability.filter(
    (entry) => entry.workerId === null || entry.workerId === workerId,
  );
}

export function availableCatalogModelIds(
  catalog: ProviderModelCatalogResult,
  workerId: string | null,
) {
  const scoped = catalogAvailabilityForWorker(catalog.availability, workerId);
  const accountScoped = scoped.filter(
    ({ scopeKey }) => scopeKey === "openrouter:user",
  );
  return new Set(
    (accountScoped.length > 0 ? accountScoped : scoped)
      .filter(({ state }) => state === "available")
      .map(({ providerModelId }) => providerModelId),
  );
}

export function catalogDisplayStatus(
  provider: ModelProviderSummary,
  catalog: ProviderModelCatalogResult | undefined,
  workerId: string | null,
): CatalogDisplayStatus {
  if (!providerSupportsCatalog(provider)) return "manual";
  if (!catalog) return "unknown";
  const scopes = catalogScopesForWorker(catalog.syncStates, workerId);
  if (scopes.some(({ status }) => status === "refreshing")) {
    return "refreshing";
  }
  if (
    catalog.servedStale ||
    scopes.some(({ status }) => status === "stale") ||
    (scopes.some(({ status }) => status === "failed") &&
      scopes.some(({ status }) => status === "current"))
  ) {
    return "stale";
  }
  if (scopes.some(({ status }) => status === "failed")) return "failed";
  if (scopes.some(({ status }) => status === "current")) return "current";
  return "unknown";
}

export function latestCatalogSuccess(
  catalog: ProviderModelCatalogResult | undefined,
  workerId: string | null,
) {
  const timestamps = catalog
    ? catalogScopesForWorker(catalog.syncStates, workerId)
        .map(({ lastSuccessAt }) => lastSuccessAt)
        .filter((value): value is string => Boolean(value))
        .map((value) => new Date(value).getTime())
        .filter(Number.isFinite)
    : [];
  return timestamps.length > 0
    ? new Date(Math.max(...timestamps)).toISOString()
    : null;
}

export function catalogModelAvailable(
  model: ProviderModelCatalogEntry,
  catalog: ProviderModelCatalogResult,
  workerId: string | null,
) {
  return availableCatalogModelIds(catalog, workerId).has(model.id);
}

export function catalogScopeLabel(
  provider: ModelProviderSummary,
  catalog: ProviderModelCatalogResult | undefined,
  workerId: string | null,
) {
  if (!providerSupportsCatalog(provider)) return "Custom IDs";
  if (provider.kind === "ollama") {
    const workers = new Set(
      catalog?.availability.flatMap(({ workerId: id }) => (id ? [id] : [])) ??
        [],
    );
    const count = workers.size || (workerId ? 1 : 0);
    return `${count} worker${count === 1 ? "" : "s"}`;
  }
  if (provider.kind === "chatgpt") {
    const accounts = provider.accounts.filter((account) => {
      if (!account.enabled) return false;
      return account.workerBindings.some(
        (binding) =>
          binding.authState === "signed-in" &&
          (!workerId || binding.workerId === workerId),
      );
    });
    return `${accounts.length} signed-in account${accounts.length === 1 ? "" : "s"}`;
  }
  return provider.hasApiKey ? "Account + global" : "Global";
}

export function formatCatalogAge(timestamp: string | null, now = Date.now()) {
  if (!timestamp) return "Never refreshed";
  const elapsed = Math.max(0, now - new Date(timestamp).getTime());
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

export function formatContextWindow(tokens: number | null) {
  if (!tokens) return null;
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}m context`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k context`;
  return `${tokens} context`;
}
