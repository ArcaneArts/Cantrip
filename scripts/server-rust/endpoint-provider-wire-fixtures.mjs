import * as p from "../../packages/protocol/dist/index.js";

const observedAt = "2026-11-04T00:00:00.000Z";
export const endpointInventoryModel = {
  nativeModelId: " fixture/model ",
  displayName: " Fixture endpoint model ",
  description: null,
  contextWindow: 32768,
  maxOutputTokens: null,
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  supportsTools: true,
  supportsParallelTools: null,
  supportsStructuredOutput: false,
  supportsVision: true,
  supportsReasoning: null,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: null,
  reasoningMandatory: null,
  family: null,
  parameterSize: null,
  quantization: null,
  digest: null,
  metadataSource: "compatible-api",
  loaded: null,
};

// Append coverage without replacing the previously exercised fixture objects.
export function appendEndpointProviderWireFixtures(fixtures) {
  fixtures.endpointModelInventorySchema = [
    { models: [], observedAt },
    ...[null, false, true].map((loaded) => ({
      models: [{ ...endpointInventoryModel, loaded }],
      observedAt,
    })),
  ];
  const catalogModel = {
    ...endpointInventoryModel,
    id: "endpoint-model",
    providerId: "fixture-provider",
    canonicalModelId: null,
    matchConfidence: null,
    hidden: false,
    isDefault: false,
    createdAt: observedAt,
    updatedAt: observedAt,
    lastSeenAt: observedAt,
  };
  const catalog = fixtures.providerModelCatalogResultSchema[0];
  for (const loaded of [null, false, true])
    fixtures.providerModelCatalogResultSchema.push({
      ...catalog,
      models: [{ ...catalogModel, loaded }],
    });

  const handoff = fixtures.nativeRuntimeHandoffConfigurationSchema[0];
  const bundle = fixtures.settingsBundleWireSchema[0];
  const summary = fixtures.modelProviderWireSummarySchema[0];
  const create = fixtures.encryptedModelProviderCreateSchema[0];
  const initialAccount = fixtures.encryptedModelProviderCreateSchema.find(
    (input) => input.initialAccount,
  ).initialAccount;
  const update = fixtures.encryptedModelProviderUpdateSchema[0];
  const inventory = fixtures.nativeModelInventorySchema[0];
  const chatInventory = fixtures.nativeChatModelInventorySchema[0];
  for (const kind of p.modelProviderKindSchema.options) {
    const provider = { ...summary, kind };
    fixtures.encryptedModelProviderCreateSchema.push({
      ...create,
      kind,
      initialAccount: p.isAccountProviderKind(kind)
        ? initialAccount
        : create.initialAccount,
    });
    fixtures.encryptedModelProviderUpdateSchema.push({ ...update, kind });
    fixtures.modelProviderWireSummarySchema.push(provider);
    fixtures.settingsBundleWireSchema.push({
      ...bundle,
      providers: [provider],
    });
    fixtures.nativeModelInventorySchema.push({
      ...inventory,
      providerKind: kind,
    });
    fixtures.nativeChatModelInventorySchema.push({
      ...chatInventory,
      providerKind: kind,
    });
    fixtures.nativeRuntimeHandoffConfigurationSchema.push({
      ...handoff,
      configuration: {
        ...handoff.configuration,
        provider: { ...handoff.configuration.provider, kind },
      },
    });
  }
}

export function* endpointProviderWireCases(name) {
  if (name === "endpointModelInventorySchema")
    for (const length of [999, 1000, 1001])
      yield {
        models: Array.from({ length }, () => ({ ...endpointInventoryModel })),
        observedAt,
      };
}
