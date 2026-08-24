import { describe, expect, it } from "vitest";

import {
  RUN_CONFIGURATION_RUNTIME_LIST_LIMIT,
  RUN_CONFIGURATION_RUNTIME_OUTPUT_LIMIT,
  runConfigurationRuntimeLifecycleRequestSchema,
  runConfigurationRuntimeOperationRecordSchema,
  runConfigurationRuntimeOutputQuerySchema,
  runConfigurationRuntimeSchema,
  runConfigurationRuntimeStatusQuerySchema,
  runConfigurationRuntimeWorkerObservationSchema,
} from "./run-configuration-runtime.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const configurationId = "22222222-2222-4222-8222-222222222222";
const worktreeId = "33333333-3333-4333-8333-333333333333";
const runtimeId = "44444444-4444-4444-8444-444444444444";
const operationId = "55555555-5555-4555-8555-555555555555";
const revision = "a".repeat(64);

function runtime() {
  return {
    id: runtimeId,
    projectId,
    configurationId,
    worktreeId,
    workerId: "worker-1",
    terminalId: null,
    definitionRevision: revision,
    codexEnvironmentRevision: null,
    generation: 1,
    requestedOperationId: operationId,
    state: "running" as const,
    startedAt: "2026-08-24T01:00:00.000Z",
    endedAt: null,
    exitCode: null,
    signal: null,
    failure: null,
    createdAt: "2026-08-24T00:59:59.000Z",
    updatedAt: "2026-08-24T01:00:00.000Z",
  };
}

describe("Run configuration runtime protocol", () => {
  it("parses the complete durable runtime without execution payloads", () => {
    const parsed = runConfigurationRuntimeSchema.parse(runtime());
    expect(parsed).toEqual(runtime());
    expect(parsed).not.toHaveProperty("command");
    expect(parsed).not.toHaveProperty("environment");
    expect(parsed).not.toHaveProperty("output");
    expect(() =>
      runConfigurationRuntimeSchema.parse({
        ...runtime(),
        command: "pnpm dev",
      }),
    ).toThrow();
  });

  it("requires explicit stable identity on lifecycle mutations", () => {
    expect(
      runConfigurationRuntimeLifecycleRequestSchema.parse({
        operation: "start",
        operationId,
        projectId,
        configurationId,
        targetWorktreeId: null,
      }),
    ).toEqual({
      operation: "start",
      operationId,
      projectId,
      configurationId,
      targetWorktreeId: null,
    });
    expect(() =>
      runConfigurationRuntimeLifecycleRequestSchema.parse({
        operation: "start",
        operationId,
        projectId,
        configurationName: "API",
        targetWorktreeId: null,
      }),
    ).toThrow();
  });

  it("bounds status and volatile output reads", () => {
    expect(
      runConfigurationRuntimeStatusQuerySchema.parse({
        operationId,
        projectId,
        configurationId: null,
        targetWorktreeId: null,
      }).limit,
    ).toBe(RUN_CONFIGURATION_RUNTIME_LIST_LIMIT);
    expect(() =>
      runConfigurationRuntimeStatusQuerySchema.parse({
        operationId,
        projectId,
        configurationId: null,
        targetWorktreeId: null,
        limit: RUN_CONFIGURATION_RUNTIME_LIST_LIMIT + 1,
      }),
    ).toThrow();
    expect(() =>
      runConfigurationRuntimeOutputQuerySchema.parse({
        operationId,
        projectId,
        configurationId,
        worktreeId,
        tail: RUN_CONFIGURATION_RUNTIME_OUTPUT_LIMIT + 1,
      }),
    ).toThrow();
  });

  it("rejects malformed worker terminal observations", () => {
    const observation = {
      runtimeId,
      projectId,
      configurationId,
      worktreeId,
      workerId: "worker-1",
      definitionRevision: revision,
      codexEnvironmentRevision: null,
      generation: 1,
      operationId,
      terminalId: null,
      state: "exited" as const,
      startedAt: "2026-08-24T01:00:00.000Z",
      endedAt: "2026-08-24T01:01:00.000Z",
      exitCode: 0,
      signal: null,
      failure: null,
    };
    expect(
      runConfigurationRuntimeWorkerObservationSchema.parse(observation),
    ).toEqual(observation);
    expect(() =>
      runConfigurationRuntimeWorkerObservationSchema.parse({
        ...observation,
        endedAt: null,
      }),
    ).toThrow(/end time/iu);
    expect(() =>
      runConfigurationRuntimeWorkerObservationSchema.parse({
        ...observation,
        state: "running",
        endedAt: null,
        failure: {
          phase: "spawn",
          code: "spawn-failed",
          message: "redacted",
          retryable: true,
        },
      }),
    ).toThrow(/failure metadata/iu);
  });

  it("keeps operation ledger records bounded and revision-only", () => {
    const record = runConfigurationRuntimeOperationRecordSchema.parse({
      id: operationId,
      projectId,
      configurationId,
      worktreeId,
      runtimeId,
      workerId: "worker-1",
      operation: "start",
      outcome: "accepted",
      generation: 1,
      definitionRevision: revision,
      codexEnvironmentRevision: null,
      createdAt: "2026-08-24T01:00:00.000Z",
    });
    expect(record).not.toHaveProperty("command");
    expect(record).not.toHaveProperty("environment");
    expect(record).not.toHaveProperty("output");
  });
});
