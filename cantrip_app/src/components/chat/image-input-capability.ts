import type {
  ModelProfileSummary,
  ModelProviderSummary,
  ProviderModelCatalogEntry,
  ProviderModelCatalogResult,
} from "@cantrip/protocol";

export type ImageInputCapabilityState =
  "mixed" | "supported" | "unknown" | "unsupported";

export interface ImageInputCapability {
  state: ImageInputCapabilityState;
  supportedProviders: string[];
  unknownProviders: string[];
  unsupportedProviders: string[];
}

function normalizedIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized ? normalized : null;
}

function routeCatalogModel(
  route: ModelProfileSummary["routes"][number],
  catalog: ProviderModelCatalogResult | undefined,
): ProviderModelCatalogEntry | undefined {
  if (!catalog) return undefined;
  if (route.providerModelId) {
    const linked = catalog.models.find(
      ({ id }) => id === route.providerModelId,
    );
    if (linked) return linked;
  }
  const routeName = normalizedIdentity(route.modelName);
  return catalog.models.find(({ canonicalModelId, nativeModelId }) =>
    [canonicalModelId, nativeModelId]
      .map(normalizedIdentity)
      .includes(routeName),
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function resolveImageInputCapability(input: {
  catalogs: ReadonlyMap<string, ProviderModelCatalogResult | undefined>;
  model: ModelProfileSummary;
  providers: ModelProviderSummary[];
}): ImageInputCapability {
  const providers = new Map(
    input.providers.map((provider) => [provider.id, provider]),
  );
  const supportedProviders: string[] = [];
  const unknownProviders: string[] = [];
  const unsupportedProviders: string[] = [];

  for (const route of input.model.routes.filter(({ enabled }) => enabled)) {
    const provider = providers.get(route.providerId);
    const providerName = provider?.name ?? route.providerName;
    const supportsVision =
      provider?.kind === "chatgpt"
        ? true
        : routeCatalogModel(route, input.catalogs.get(route.providerId))
            ?.supportsVision;
    if (supportsVision === true) supportedProviders.push(providerName);
    else if (supportsVision === false) unsupportedProviders.push(providerName);
    else unknownProviders.push(providerName);
  }

  const supported = unique(supportedProviders);
  const unknown = unique(unknownProviders);
  const unsupported = unique(unsupportedProviders);
  const state: ImageInputCapabilityState =
    unknown.length > 0 || (supported.length === 0 && unsupported.length === 0)
      ? "unknown"
      : supported.length > 0 && unsupported.length > 0
        ? "mixed"
        : supported.length > 0
          ? "supported"
          : "unsupported";
  return {
    state,
    supportedProviders: supported,
    unknownProviders: unknown,
    unsupportedProviders: unsupported,
  };
}

function providerList(providers: string[]): string {
  return providers.join(", ");
}

export function imageInputCapabilityMessage(
  modelName: string,
  capability: ImageInputCapability,
): string {
  if (capability.state === "supported") {
    return `${modelName} accepts image input.`;
  }
  if (capability.state === "unsupported") {
    const route = capability.unsupportedProviders.length
      ? ` through ${providerList(capability.unsupportedProviders)}`
      : "";
    return `${modelName} is text-only${route}. The image will stay attached so you can switch models; if sent now, the agent receives its worker-local file path instead.`;
  }
  if (capability.state === "mixed") {
    return `${modelName} accepts images through ${providerList(capability.supportedProviders)}, but not through ${providerList(capability.unsupportedProviders)}. The image will stay attached; a text-only route receives its worker-local file path instead.`;
  }
  const route = capability.unknownProviders.length
    ? ` for ${providerList(capability.unknownProviders)}`
    : "";
  return `No image capability metadata is available${route}. The image will stay attached; if the selected route is text-only, the agent receives its worker-local file path instead.`;
}
