import * as operations from "../../packages/protocol/dist/run-configuration-operations.js";
import * as definitions from "../../packages/protocol/dist/run-configuration-definitions.js";
import { runDefinition } from "./run-lifecycle-http-cases.mjs";
import { runConfigurationSecretSummaryListSchema } from "../../packages/protocol/dist/run-configuration-secrets.js";
import { outcome } from "./security-oracle.mjs";
const base = runDefinition({
  operationId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  configurationId: "33333333-3333-4333-8333-333333333333",
});
const cases = [];
function add(schema, input) {
  cases.push({
    schema,
    input,
    outcome: outcome(
      operations[schema] ??
        definitions[schema] ??
        runConfigurationSecretSummaryListSchema,
      input,
    ),
  });
}
add("runConfigurationGetResponseSchema", base);
for (const status of ["ready", "invalid", "unsupported"])
  for (const document of [null, base.result.entry.document])
    for (const revision of [null, "", "a".repeat(64)]) {
      const value = structuredClone(base);
      Object.assign(value.result.entry, { status, document, revision });
      add("runConfigurationGetResponseSchema", value);
    }
for (const configured of [false, true])
  for (const valid of [false, true])
    for (const revision of [null, "a".repeat(64)])
      for (const hasSetup of [false, true]) {
        const value = structuredClone(base);
        Object.assign(value.codexEnvironment, {
          configured,
          valid,
          revision,
          hasSetup,
        });
        add("runConfigurationGetResponseSchema", value);
      }
for (const available of [false, true])
  for (const revision of [null, 1])
    for (const updatedAt of [null, "2026-10-25T00:00:00.000Z"]) {
      const secret = {
        reference: "database/url",
        available,
        revision,
        updatedAt,
      };
      add("runConfigurationSecretSummaryListSchema", [secret]);
      add("runConfigurationSecretSummaryListSchema", [secret, secret]);
    }
const mismatched = structuredClone(base);
mismatched.result.entry.id = base.projectId;
add("runConfigurationGetResponseSchema", mismatched);
const context = { operationId: base.operationId, projectId: base.projectId };
const entry = base.result.entry;
const validation = {
  configurationId: entry.id,
  provider: "shell",
  platform: "linux",
  effectiveCommand: "echo acceptance",
  valid: true,
  diagnostics: [],
};
for (const valid of [false, true])
  for (const diagnostics of [
    [],
    [{ severity: "error", code: "test", message: "test" }],
  ]) {
    add("runConfigurationValidateResponseSchema", {
      operation: "validate",
      ...context,
      validation: { ...validation, valid, diagnostics },
    });
  }
for (const entries of [[], [entry], [entry, entry]])
  for (const validations of [
    [],
    [validation],
    [validation, validation],
    [{ ...validation, provider: "node" }],
  ]) {
    add("runConfigurationListResponseSchema", {
      operation: "list",
      ...context,
      inventory: {
        directory: ".cantrip/run-configurations",
        entries,
        diagnostics: [],
      },
      validations,
    });
  }
for (const provider of ["shell", "node"])
  add("runConfigurationDetectResponseSchema", {
    operation: "detect",
    ...context,
    candidates: [
      {
        provider,
        confidence: "high",
        reason: "fixture",
        effectiveCommand: "echo test",
        document: entry.document,
      },
    ],
    diagnostics: [],
  });
for (const status of ["ready", "invalid", "unsupported"])
  add("runConfigurationWriteResponseSchema", {
    operation: "write",
    ...context,
    result: { outcome: "created", entry: { ...entry, status } },
  });
for (const value of [
  null,
  {},
  { operationId: context.operationId },
  { operationId: context.operationId, purpose: "file" },
  { operationId: context.operationId, purpose: "file", query: "a\0b" },
  { operationId: context.operationId, purpose: "file", query: "a".repeat(257) },
  { operationId: [context.operationId, context.operationId] },
]) {
  for (const schema of [
    "runConfigurationListQuerySchema",
    "runConfigurationDetectQuerySchema",
    "runConfigurationPathsQuerySchema",
  ])
    add(schema, value);
}
for (const value of [
  null,
  {},
  { operationId: context.operationId, document: entry.document },
  {
    operationId: context.operationId,
    document: entry.document,
    expectedRevision: null,
  },
]) {
  for (const schema of [
    "runConfigurationApiValidateRequestSchema",
    "runConfigurationApiFlutterDevicesRequestSchema",
    "runConfigurationApiWriteRequestSchema",
    "runConfigurationApiDeleteRequestSchema",
  ])
    add(schema, value);
}
const capability = {
  provider: "shell",
  label: "Shell",
  icon: "terminal",
  available: true,
  supportsDiscovery: true,
  supportsCommandOverride: true,
  supportsBeforeLaunch: true,
  supportsPlatformOverrides: true,
};
for (const capabilities of [[capability], [capability, capability]])
  add("runConfigurationCapabilitiesResponseSchema", {
    operation: "capabilities",
    ...context,
    capabilities,
  });
console.log(JSON.stringify({ cases }));
