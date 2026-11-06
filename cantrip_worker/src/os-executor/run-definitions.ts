import {
  cantripOsRunDefinitionWorkerCommandSchema,
  type WorkerCommand,
} from "@cantrip/protocol";
import { runConfigurationOperationResponseSchema } from "@cantrip/protocol/run-configuration-operations";
import type { CantripOsController } from "./controller.js";
import { OsExecutorConnection, OsExecutorDeliveryError } from "./connection.js";
import { OsOperationStore } from "./operations.js";
import {
  observeGuestProcess,
  runGuestProcess,
  type GuestProcessResult,
} from "./process.js";

type Command = Extract<WorkerCommand, { type: "cantrip-os.run-definition" }>;
const response = (result: GuestProcessResult) => {
  if (result.outputTruncated)
    throw new OsExecutorDeliveryError(
      "The Linux Run definition output is incomplete; its mutation was not repeated.",
    );
  if (result.exitCode !== 0 || result.terminationRequested || result.failure)
    throw new OsExecutorDeliveryError(
      `The Linux Run definition helper did not complete successfully: ${result.stderr.slice(-4000)}`,
    );
  try {
    return runConfigurationOperationResponseSchema.parse(
      JSON.parse(result.stdout),
    );
  } catch (cause) {
    const error = new OsExecutorDeliveryError(
      "The Linux Run definition completion is unreadable; its mutation was not repeated.",
    );
    error.cause = cause;
    throw error;
  }
};

/** Orchestration and durable admissions remain Worker-owned. Only shared file,
 * discovery, and validation semantics execute in an authenticated Linux child. */
export class OsRunDefinitionOperations {
  private readonly operations: OsOperationStore;
  constructor(
    directory: string,
    private readonly controller: Pick<
      CantripOsController,
      "captureExecutionBinding"
    >,
    private readonly authority: { ownerId(): string; serverIdentity(): string },
  ) {
    this.operations = new OsOperationStore(directory);
  }
  async execute(supplied: Command) {
    const command = cantripOsRunDefinitionWorkerCommandSchema.parse(supplied);
    const { execution, request } = command;
    if (
      execution.scope.ownerId !== this.authority.ownerId() ||
      request.projectId !== execution.scope.projectId
    )
      throw new Error(
        "The Linux Run definition belongs to another account or project.",
      );
    const scope = {
      ...execution.scope,
      serverId: this.authority.serverIdentity(),
    };
    const binding = await this.controller.captureExecutionBinding(
      execution.transport,
      scope,
    );
    let record = await this.operations.execute(
      scope,
      request.operationId,
      command.type,
      { execution, request },
      async (record, save) => {
        const connection = new OsExecutorConnection(
          execution.transport,
          binding,
        );
        try {
          const { sessionId } = await connection.request<{ sessionId: string }>(
            "initialize",
            {
              clientName: "cantrip-run-definitions",
              resumeSessionId: null,
            },
          );
          connection.notify("initialized");
          record.native = { binding, sessionId };
          await save();
          const argv = [
            "/usr/bin/node",
            "/usr/lib/cantrip-os-executor/run-definitions.mjs",
            scope.guestPath,
          ];
          return response(
            await runGuestProcess(connection, argv, scope.guestPath, {
              stdin: JSON.stringify(request) + "\n",
              maxDurationMs: 180_000,
              maxOutputBytes: 8 * 1024 * 1024,
              prepared: async (processId) => {
                record.processes.push({ processId, argv });
                await save();
              },
            }),
          );
        } finally {
          await connection.close();
        }
      },
    );
    if (
      record.state === "unknown" &&
      record.native &&
      record.processes.length === 1
    ) {
      const connection = new OsExecutorConnection(execution.transport, binding);
      try {
        const { sessionId } = await connection.request<{ sessionId: string }>(
          "initialize",
          {
            clientName: "cantrip-run-definition-observe",
            resumeSessionId: record.native.sessionId,
          },
        );
        connection.notify("initialized");
        if (
          sessionId !== record.native.sessionId ||
          binding.executor_generation !==
            record.native.binding.executor_generation
        )
          throw new Error(
            "The Linux definition session changed; its mutation was not repeated.",
          );
        const result = response(
          await observeGuestProcess(connection, record.processes[0]!.processId),
        );
        record = await this.operations.recordObservedCompletion(record, result);
      } finally {
        await connection.close();
      }
    }
    if (record.state !== "ready")
      throw new Error(
        record.state === "unknown" || record.state === "running"
          ? "The Linux Run definition outcome is unknown. Observe this same operation; its mutation was not repeated."
          : "The Linux Run definition operation failed. Inspect Worker diagnostics before issuing a new operation.",
      );
    const result = runConfigurationOperationResponseSchema.parse(
      record.receipt,
    );
    if (
      result.projectId !== request.projectId ||
      result.operationId !== request.operationId ||
      `project.run-configuration-definitions.${result.operation}` !==
        request.type
    )
      throw new Error("The Linux Run definition result was misrouted.");
    return result;
  }
}
