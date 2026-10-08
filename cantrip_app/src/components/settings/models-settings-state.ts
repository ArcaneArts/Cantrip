import type {
  ModelProfileSummary,
  ModelProviderSummary,
} from "@cantrip/protocol";

export type ModelsSettingsTab = "general" | `provider:${string}`;

export function providerModelsTab(providerId: string): ModelsSettingsTab {
  return `provider:${providerId}`;
}

export function modelsForProvider(
  models: readonly ModelProfileSummary[],
  providerId: string,
) {
  // Disabled routes remain editable, and a failover model belongs to each of its providers.
  return models.filter((model) =>
    model.routes.some((route) => route.providerId === providerId),
  );
}

export function unassignedModels(
  models: readonly ModelProfileSummary[],
  providers: readonly ModelProviderSummary[],
) {
  const ids = new Set(providers.map(({ id }) => id));
  return models.filter(
    (model) => !model.routes.some((route) => ids.has(route.providerId)),
  );
}

export function modelsSettingsSearchTab(
  itemId: string,
  models: readonly ModelProfileSummary[],
  providers: readonly ModelProviderSummary[],
): ModelsSettingsTab {
  if (itemId.startsWith("provider:")) {
    return providers.some(
      (provider) => providerModelsTab(provider.id) === itemId,
    )
      ? (itemId as ModelsSettingsTab)
      : "general";
  }
  const model = itemId.startsWith("model:")
    ? models.find(({ id }) => id === itemId.slice(6))
    : undefined;
  const hasProvider = (route: ModelProfileSummary["routes"][number]) =>
    providers.some(({ id }) => id === route.providerId);
  const route =
    model?.routes.find((route) => route.enabled && hasProvider(route)) ??
    model?.routes.find(hasProvider);
  return route ? providerModelsTab(route.providerId) : "general";
}
