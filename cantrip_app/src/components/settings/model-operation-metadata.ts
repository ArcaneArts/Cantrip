import type {
  ModelOperation,
  ModelOperationCapabilities,
  ProviderModelCatalogEntry,
  ProviderModelCatalogResult,
} from "@cantrip/protocol";

export const modelOperationLabels: Record<ModelOperation, string> = {
  language: "Language",
  embedding: "Embedding",
  decision: "Decision",
};

/** Index once per catalog so large model lists do not repeatedly scan availability. */
export function scopedCapabilitiesByModel(
  catalog: ProviderModelCatalogResult | undefined,
  workerId: string | null,
): ReadonlyMap<string, ModelOperationCapabilities> {
  const observations = new Map<
    string,
    ProviderModelCatalogResult["availability"]
  >();
  for (const observation of catalog?.availability ?? []) {
    const group = observations.get(observation.providerModelId) ?? [];
    group.push(observation);
    observations.set(observation.providerModelId, group);
  }
  return new Map(
    catalog?.models.map((model) => {
      const all = observations.get(model.id) ?? [];
      const matching = all
        .filter(
          (observation) =>
            observation.workerId === null || observation.workerId === workerId,
        )
        .sort(
          (a, b) =>
            Number(b.workerId === workerId && workerId !== null) -
              Number(a.workerId === workerId && workerId !== null) ||
            b.updatedAt.localeCompare(a.updatedAt),
        );
      const capabilities =
        matching.find((observation) => observation.operationCapabilities)
          ?.operationCapabilities ??
        (all.some((observation) => observation.workerId !== null)
          ? {}
          : (model.operationCapabilities ?? {}));
      return [model.id, capabilities] as const;
    }),
  );
}

/** Never show another worker's latest observation as this worker's capability. */
export function scopedOperationCapabilities(
  model: ProviderModelCatalogEntry,
  catalog: ProviderModelCatalogResult,
  workerId: string | null,
): ModelOperationCapabilities {
  return scopedCapabilitiesByModel(catalog, workerId).get(model.id) ?? {};
}

export function operationCapabilityText(
  operation: ModelOperation,
  capabilities: ModelOperationCapabilities,
): string {
  const capability = capabilities[operation];
  if (!capability || capability.status === "unknown")
    return "Capability unverified";
  if (capability.status === "unsupported")
    return "Not advertised for this operation";
  const parts = capability.inputModalities?.length
    ? [capability.inputModalities.join(" + ")]
    : [];
  if (operation === "embedding") {
    const embedding = capabilities.embedding;
    if (embedding?.dimensions)
      parts.push(`${embedding.dimensions.toLocaleString()} dimensions`);
    if (embedding?.configurableDimensions)
      parts.push("configurable dimensions");
    if (embedding?.vectorRepresentation)
      parts.push(embedding.vectorRepresentation);
  }
  if (operation === "decision" && capabilities.decision?.questionTypes?.length)
    parts.push(capabilities.decision.questionTypes.join(" / "));
  return parts.join(" · ") || "Supported · details unavailable";
}
