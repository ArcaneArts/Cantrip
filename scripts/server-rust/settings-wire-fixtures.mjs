import * as p from "../../packages/protocol/dist/index.js";
import { policyEnvelope } from "./policy-wire-fixtures.mjs";
import {
  chatGptCatalogModel,
  grokCatalogModel,
  quotaSnapshot,
  capturedCredentialFixture,
} from "./settings-provider-fixtures.mjs";

const cursor = {
  operationId: "11111111-1111-4111-8111-111111111111",
  protectedContent: { ...policyEnvelope, domain: "customization-content" },
};

const route = { providerId: "fixture-provider", modelName: " fixture/model " };
const create = { name: " Fixture model ", routes: [route] };
const model = {
  ...create,
  id: "fixture-model",
  routingPolicy: "priority",
  routes: [
    { ...route, id: "fixture-route", providerName: "Provider", position: 0 },
  ],
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
};
const preferences = p.userSettingsSchema.parse({
  theme: "system",
  highContrast: false,
  proMode: false,
  proModeOpacity: 80,
  sidebarWidth: 288,
  desktopFrameRate: 30,
  desktopStreamQuality: "adaptive",
  defaultModelId: null,
});
const destination = {
  lastAppMode: null,
  lastIdeProjectId: null,
  lastIdeWorkspaceId: null,
  lastStandaloneChatId: null,
};
const providerAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  providerId: "fixture-provider",
  protectedLabel: policyEnvelope,
  planType: null,
  position: 0,
  enabled: true,
  credentialState: "signed-out",
  weeklyUsageUsedPercent: null,
  weeklyUsageResetsAt: null,
  authLastSyncedAt: null,
  workerBindings: [],
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
};
export const settingsWireFixtures = {
  providerModelCatalogResultSchema: [
    {
      providerId: "fixture-provider",
      models: [],
      availability: [],
      syncStates: [],
      servedStale: false,
    },
  ],
  encryptedModelProviderAccountCreateSchema: [
    { id: providerAccount.id, protectedLabel: policyEnvelope },
  ],
  encryptedModelProviderAccountUpdateSchema: [
    { enabled: false },
    { protectedLabel: policyEnvelope },
  ],
  modelProviderAccountWireSummarySchema: [providerAccount],
  modelProviderAccountWireListSchema: [[], [providerAccount]],
  orderedIdsSchema: [
    { ids: ["fixture-account"] },
    { ids: ["\ud800"], strip: true },
  ],
  providerAuthLiveStatusSchema: [
    {
      providerId: "fixture-provider",
      providerAccountId: providerAccount.id,
      providerKind: "chatgpt",
      workerId: "server",
      revision: 1,
      observedAt: "2026-10-25T00:00:00.000Z",
      expiresAt: null,
      status: {
        state: "signed-out",
        authMode: null,
        email: null,
        planType: null,
        weeklyUsage: null,
        failureCode: null,
      },
    },
    {
      providerId: "fixture-provider",
      providerAccountId: providerAccount.id,
      providerKind: "grok",
      workerId: "fixture-worker",
      revision: 2,
      observedAt: "2026-10-25T00:00:00.000Z",
      expiresAt: "2026-10-25T00:15:00.000Z",
      status: {
        state: "authenticated",
        authMode: "grok",
        email: null,
        planType: "pro",
        weeklyUsage: null,
        failureCode: null,
      },
    },
  ],
  codexAuthStatusSchema: [
    {
      authenticated: false,
      authMode: null,
      email: null,
      planType: null,
      weeklyUsage: null,
    },
    {
      authenticated: true,
      authMode: "chatgpt",
      email: "fixture@example.invalid",
      planType: "pro",
      weeklyUsage: { usedPercent: 12.34, resetsAt: 1793577600 },
      loginPending: false,
      loginError: null,
    },
  ],
  codexDeviceLoginSchema: [
    {
      loginId: "fixture-login",
      verificationUrl: "https://auth.example.invalid/device",
      userCode: "ABCD-1234",
    },
    {
      loginId: "a",
      verificationUrl: "custom:device",
      userCode: "1",
      ignored: true,
    },
  ],
  providerCredentialUploadSchema: [
    {
      credential: capturedCredentialFixture(65),
      expectedRevision: 0,
      metadata: { expiresAt: null },
    },
    {
      credential: capturedCredentialFixture(66),
      expectedRevision: 3,
      metadata: { expiresAt: "2030-01-01T00:00:00.123456789Z" },
    },
  ],
  providerCredentialWireRecordSchema: [
    {
      accountId: "fixture-account",
      credential: capturedCredentialFixture(65),
      credentialRevision: 1,
      providerId: "fixture-provider",
      providerKind: "chatgpt",
    },
    {
      accountId: "fixture-account",
      credential: capturedCredentialFixture(66),
      credentialRevision: 4,
      providerId: "fixture-provider",
      providerKind: "grok",
    },
  ],
  providerLegacyCredentialCaptureResultSchema: [
    { status: "missing" },
    { status: "malformed" },
    {
      status: "available",
      credential: capturedCredentialFixture(65),
      metadata: { expiresAt: null },
    },
    {
      status: "available",
      portableAuth: true,
      credential: capturedCredentialFixture(66),
      metadata: { expiresAt: "2030-01-01T00:00:00.000Z" },
    },
  ],
  providerLegacyCredentialPurgeResultSchema: [
    {
      purged: true,
      serverCredentialRevision: 1,
      subjectBlindIndex: capturedCredentialFixture(65).subjectBlindIndex,
    },
    {
      purged: false,
      serverCredentialRevision: 5,
      subjectBlindIndex: capturedCredentialFixture(66).subjectBlindIndex,
    },
  ],
  providerQuotaSnapshotSchema: [
    quotaSnapshot,
    { ...quotaSnapshot, windows: [], credits: null },
  ],
  chatGptModelInventorySchema: [
    { observedAt: "2026-10-27T00:00:00.000Z", models: [chatGptCatalogModel] },
    {
      observedAt: "2026-10-27T00:00:00.000Z",
      models: [],
      quotaSnapshot,
      weeklyUsage: { usedPercent: 13.5, resetsAt: 0 },
    },
  ],
  grokModelInventorySchema: [
    {
      observedAt: "2026-10-27T00:00:00.000Z",
      models: [grokCatalogModel],
      quotaSnapshot,
    },
  ],
  modelProfileCreateSchema: [
    create,
    {
      ...create,
      routes: [
        { ...route, enabled: false },
        { ...route, id: "existing", enabled: true },
      ],
    },
  ],
  modelProfileUpdateSchema: [create],
  modelProfileSummarySchema: [model],
  chatReasoningStateSchema: [
    {
      modelId: "fixture-model",
      reasoningEffort: "high",
      options: [{ effort: "high", description: "High reasoning" }],
      reasoningMandatory: true,
      incompleteMetadata: false,
    },
  ],
  modelConfigurationFailureSchema: [
    {
      code: "root-model-unavailable",
      error: "The configured root model has no enabled provider routes.",
      field: "modelId",
      retryable: true,
    },
  ],
  userSettingsUpdateSchema: [
    {},
    { protectedComputerUseCursor: cursor },
    {
      ...preferences,
      computerUseEnabled: true,
      computerUseEffects: {
        effect: "cursor-warp",
        parameters: { strength: 1, radius: 64 },
      },
      mobileProjectTabConfigurations: { project: [null, "chat"] },
    },
  ],
  settingsBundleWireSchema: [{ preferences, providers: [], models: [model] }],
  appDestinationUpdateSchema: [
    { ...destination, expectedRevision: 1 },
    { lastAppMode: "chat", expectedRevision: 5 },
  ],
  appDestinationSchema: [{ ...destination, revision: 1 }],
  cuaEffectWorkerStatusSchema: [
    {
      revision: 1,
      configuration: { effect: "off", parameters: {} },
      state: "idle",
      error: null,
      native: null,
    },
  ],
  ollamaModelInventorySchema: [
    { observedAt: "2026-10-27T00:00:00.000Z", models: [] },
    {
      observedAt: "2026-10-27T00:00:00.000Z",
      models: [
        {
          name: " model 🦀 ",
          modifiedAt: null,
          sizeBytes: 1234,
          digest: " digest ",
          family: " llama ",
          families: [" llama "],
          parameterSize: " 8B ",
          quantization: " Q4 ",
          capabilities: [" tools ", "VISION"],
          modelInfo: {
            "general.architecture": "llama",
            "llama.context_length": 128000,
            opaque: { "\ud800": [null, false, 0, "🦀\udfff"] },
          },
        },
      ],
    },
  ],
};

export function* settingsWireCases(name) {
  if (name === "ollamaModelInventorySchema") {
    const inventory = settingsWireFixtures.ollamaModelInventorySchema[1];
    for (const count of [1000, 1001])
      yield { ...inventory, models: Array(count).fill(inventory.models[0]) };
    for (const count of [64, 65])
      yield {
        ...inventory,
        models: [
          { ...inventory.models[0], capabilities: Array(count).fill("vision") },
        ],
      };
    for (const count of [32, 33])
      yield {
        ...inventory,
        models: [
          { ...inventory.models[0], families: Array(count).fill("llama") },
        ],
      };
  }
  if (name === "userSettingsUpdateSchema") {
    for (const count of [200, 201])
      yield {
        mobileProjectTabConfigurations: Object.fromEntries(
          Array.from({ length: count }, (_, i) => ["project-" + i, [null]]),
        ),
      };
    for (const length of [4112, 4113, 4114])
      yield {
        protectedComputerUseCursor: {
          ...cursor,
          protectedContent: {
            ...cursor.protectedContent,
            envelope: {
              ...cursor.protectedContent.envelope,
              ciphertext: Buffer.alloc(length).toString("base64url"),
            },
          },
        },
      };
    yield {
      protectedComputerUseCursor: {
        ...cursor,
        protectedContent: { ...cursor.protectedContent, domain: "run-content" },
      },
    };
  }
}
