import assert from "node:assert/strict";
import { definitionWorker } from "./run-definition-http-cases.mjs";
import { runDefinition } from "./run-definition-fixture.mjs";
import { runConfigurationRuntimeOutputContentSchema } from "../../packages/protocol/dist/run-configuration-runtime.js";
import {
  protectWorkerRunContent,
  openWorkerRunContent,
} from "../../cantrip_worker/src/run-content-encryption.ts";
import {
  protectRunConfigurationSecretValue,
  openRunConfigurationSecretValue,
} from "../../cantrip_worker/src/run-configuration-secret-encryption.ts";

export const configurationId = "eeeeeeee-eeee-4eee-8eee-000000000701";
export const privateRunMarker = "private-mcp-run-value-🔐";
export const stamp = "2026-10-25T00:00:00.000Z";
export const operations = [
  "list",
  "get",
  "detect",
  "create",
  "update",
  "delete",
  "start",
  "restart",
  "stop",
  "status",
  "read-output",
  "secret-set",
].map((action) => "run-configuration." + action);
export const mutations = new Set(
  ["create", "update", "delete", "start", "restart", "stop", "secret-set"].map(
    (action) => "run-configuration." + action,
  ),
);

export function runWorker() {
  const definitions = definitionWorker();
  definitions.enabled = true;
  const document = runDefinition({ configurationId }).result.entry.document;
  const state = {
    definitions,
    document,
    mode: null,
    commands: [],
    emptyRuntimeReconciliations: [],
    runtimes: new Map(),
    secretProofs: 0,
    outputProofs: 0,
  };
  state.onCommand = async (command, _emit, crypto) => {
    if (!command.type.startsWith("project.run-configuration-")) return;
    if (
      command.type === "project.run-configuration-runtime.reconcile" &&
      command.identities.length === 0
    ) {
      // A worker-join housekeeping request has no MCP request correlation. Its
      // timing must not attribute an unrelated command to the next HTTP call.
      // Retain the raw wire request and prove the worker has no active runtime.
      assert.ok(
        [...state.runtimes.values()].every(
          (runtime) => runtime.state === "exited",
        ),
      );
      state.emptyRuntimeReconciliations.push({
        workerId: crypto.scope.workerId,
        command: structuredClone(command),
        noActiveWorkerRuntime: true,
      });
      return { runtimes: [], orphanedRuntimeIds: [] };
    }
    state.crypto = crypto;
    state.commands.push(structuredClone(command));
    await state.beforeRunCommand?.(command);
    if (command.type.startsWith("project.run-configuration-definitions."))
      return definitions.respond(command);
    const action = command.type.split(".").at(-1);
    if (action === "reconcile")
      return {
        runtimes: command.identities.map((identity) => {
          const observation = state.runtimes.get(identity.runtimeId);
          return observation
            ? { found: true, observation }
            : { found: false, identity };
        }),
        orphanedRuntimeIds: [],
      };
    if (action === "output") {
      const opaque = await protectWorkerRunContent({
        serverId: crypto.serverId,
        projectId: command.identity.projectId,
        worktreeId: command.identity.worktreeId,
        operationId: command.requestOperationId,
        operation: "run.configuration.output",
        content: { data: privateRunMarker, truncated: false },
        schema: runConfigurationRuntimeOutputContentSchema,
        service: crypto.encryption,
      });
      state.lastOutput = opaque;
      const response = {
        requestOperationId: command.requestOperationId,
        identity: structuredClone(command.identity),
        protectedOutput: opaque,
      };
      if (state.mode === "output-misrouted") response.identity.generation++;
      if (state.mode === "output-malformed") return {};
      return response;
    }
    for (const secret of command.protectedSecrets ?? []) {
      assert.equal(
        await openRunConfigurationSecretValue({
          projectId: command.identity.projectId,
          secret,
          service: crypto.encryption,
        }),
        privateRunMarker,
      );
      state.secretProofs++;
    }
    if (state.mode === "runtime-malformed") return {};
    if (state.mode === "runtime-not-found")
      return { outcome: "not-found", observation: null };
    const observation = {
      ...command.identity,
      state: action === "stop" ? "exited" : "running",
      startedAt: stamp,
      endedAt: action === "stop" ? stamp : null,
      exitCode: action === "stop" ? 0 : null,
      signal: null,
      failure: null,
    };
    state.runtimes.set(command.identity.runtimeId, observation);
    return { outcome: "accepted", observation };
  };
  state.seal = async (projectId) =>
    protectRunConfigurationSecretValue({
      projectId,
      reference: "run/api",
      value: privateRunMarker,
      service: state.crypto.encryption,
    });
  state.verifyOutput = async (data) => {
    assert.deepEqual(data.protectedOutput, state.lastOutput);
    assert.deepEqual(
      await openWorkerRunContent({
        serverId: state.crypto.serverId,
        projectId: data.projectId,
        worktreeId: data.worktreeId,
        operationId: data.operationId,
        operation: "run.configuration.output",
        opaque: data.protectedOutput,
        schema: runConfigurationRuntimeOutputContentSchema,
        service: state.crypto.encryption,
        direction: "response",
      }),
      { data: privateRunMarker, truncated: false },
    );
    state.outputProofs++;
  };
  return state;
}
