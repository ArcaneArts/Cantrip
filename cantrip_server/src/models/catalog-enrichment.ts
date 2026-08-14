import type {
  ModelProviderSummary,
  ProviderModelCatalogEntry,
} from "@cantrip/protocol";

function normalizedIdentity(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

export function exactOpenRouterAliases(
  catalog: ProviderModelCatalogEntry,
  providerKind: ModelProviderSummary["kind"],
): Set<string> {
  const aliases = new Set<string>();
  for (const value of [catalog.nativeModelId, catalog.canonicalModelId]) {
    const normalized = normalizedIdentity(value);
    if (normalized) aliases.add(normalized);
  }
  if (providerKind === "chatgpt") {
    aliases.add(`openai/${catalog.nativeModelId.trim().toLowerCase()}`);
  }
  return aliases;
}

export function enrichCatalogFromExactOpenRouterMatch(
  catalog: ProviderModelCatalogEntry | null,
  providerKind: ModelProviderSummary["kind"],
  candidates: ProviderModelCatalogEntry[],
): ProviderModelCatalogEntry | null {
  if (!catalog || catalog.metadataSource === "openrouter") return catalog;
  const aliases = exactOpenRouterAliases(catalog, providerKind);
  const matches = candidates.filter((candidate) => {
    const identities = [candidate.nativeModelId, candidate.canonicalModelId]
      .map(normalizedIdentity)
      .filter((value): value is string => value !== null);
    return identities.some((identity) => aliases.has(identity));
  });
  if (matches.length !== 1) return catalog;

  const source = matches[0]!;
  return {
    ...catalog,
    description: catalog.description ?? source.description,
    contextWindow: catalog.contextWindow ?? source.contextWindow,
    maxOutputTokens: catalog.maxOutputTokens ?? source.maxOutputTokens,
    inputModalities:
      catalog.inputModalities.length > 0
        ? catalog.inputModalities
        : source.inputModalities,
    outputModalities:
      catalog.outputModalities.length > 0
        ? catalog.outputModalities
        : source.outputModalities,
    supportsTools: catalog.supportsTools ?? source.supportsTools,
    supportsParallelTools:
      catalog.supportsParallelTools ?? source.supportsParallelTools,
    supportsStructuredOutput:
      catalog.supportsStructuredOutput ?? source.supportsStructuredOutput,
    supportsVision: catalog.supportsVision ?? source.supportsVision,
    supportsReasoning: catalog.supportsReasoning ?? source.supportsReasoning,
    // Provider-native reasoning metadata stays authoritative. OpenRouter does
    // not currently advertise portable effort levels for another endpoint.
    supportedReasoningEfforts: catalog.supportedReasoningEfforts,
    defaultReasoningEffort: catalog.defaultReasoningEffort,
    reasoningMandatory: catalog.reasoningMandatory,
    family: catalog.family ?? source.family,
    matchConfidence: catalog.matchConfidence ?? 1,
  };
}
