import {
  clearSensitiveBytes,
  openComputerUseRequest,
  protectComputerUseResult,
} from "@cantrip/crypto";
import {
  CUA_CHUNK_BYTES,
  type ComputerUseAction,
  type ComputerUseChunkEvent,
  type ComputerUseResultContent,
  type CuaScope,
  type WorkerComputerUseCommand,
} from "@cantrip/protocol";
import {
  openWorkerEndpointBytes,
  protectWorkerEndpointBytes,
  type WorkerEndpointEncryptionService,
} from "../endpoint-content-encryption.js";
import { CuaNativeError, CuaProcessError } from "./errors.js";
import { waitBeforeCuaSend } from "./cancellation.js";
import { CantripCuaService, CuaServiceError } from "./service.js";

export class CuaAuthorizationError extends Error {
  constructor(
    readonly code:
      "approval-required" | "execution-unavailable" | "ownership-mismatch",
  ) {
    super(
      {
        "approval-required":
          "Computer use requires approval through the active permission profile.",
        "execution-unavailable":
          "The agent execution context is no longer available on this worker.",
        "ownership-mismatch":
          "Computer use belongs to another execution context.",
      }[code],
    );
    this.name = "CuaAuthorizationError";
  }
}

export interface ComputerUseHandlerDependencies {
  workerId: string;
  service: CantripCuaService;
  /** Preview leases may reuse their one owned session; agent scopes use the
   * ordinary service path. Called only after scope and permission validation. */
  openSession?: CantripCuaService["open"];
  encryption: WorkerEndpointEncryptionService & { serverIdentity(): string };
  /** Resolve from trusted worker runtime/broker state, not request turn IDs. */
  resolveExecution(command: WorkerComputerUseCommand): Promise<{
    scope: CuaScope;
    executionLaneId: string | null;
    /** Trusted owner aborts on interruption, relocation, permission revocation,
     * or disconnect, including authorization pending outside service. */
    signal: AbortSignal;
  }>;
  /** Mandatory policy seam. The caller cannot substitute an always-allow default. */
  authorize(input: {
    action: ComputerUseAction;
    scope: CuaScope;
    signal?: AbortSignal;
  }): Promise<void>;
}

/** Encrypted boundary for authorized CUA. Production preview routing supplies
 * the worker-owned lifetime and existing durable-approval policy. */
export async function handleComputerUseOperation(
  command: WorkerComputerUseCommand,
  emit: (event: ComputerUseChunkEvent) => Promise<void>,
  dependencies: ComputerUseHandlerDependencies,
  signal?: AbortSignal,
) {
  const { encryption, service } = dependencies;
  // This identity comes from the worker's granted encryption context. A server
  // cannot relabel an existing registration through public routing fields.
  if (command.serverId !== encryption.serverIdentity()) {
    throw new Error(
      "Computer-use endpoint identity could not be authenticated.",
    );
  }
  const context = {
    serverId: command.serverId,
    workerId: dependencies.workerId,
    chatId: command.chatId,
    operationId: command.request.operationId,
    operation: command.request.operation,
    ...(command.request.previewLeaseId
      ? { previewLeaseId: command.request.previewLeaseId }
      : {}),
  };
  const seal = (
    context: Parameters<typeof protectWorkerEndpointBytes>[0]["context"],
    plaintext: Uint8Array,
  ) => protectWorkerEndpointBytes({ context, plaintext, service: encryption });
  let payload: Buffer | null = null;
  let result: ComputerUseResultContent;
  try {
    const execution = await dependencies.resolveExecution(command);
    const scope = { ...execution.scope };
    signal = signal
      ? AbortSignal.any([signal, execution.signal])
      : execution.signal;
    if (
      scope.serverId !== command.serverId ||
      scope.ownerId !== encryption.ownerId() ||
      scope.workerId !== dependencies.workerId ||
      scope.chatId !== command.chatId ||
      execution.executionLaneId !== command.executionLaneId
    ) {
      throw new CuaAuthorizationError("ownership-mismatch");
    }
    const action = await openComputerUseRequest({
      context,
      opaque: command.request,
      open: (context, opaque) =>
        openWorkerEndpointBytes({ context, opaque, service: encryption }),
    });
    if (action.operation !== "session.close") {
      if (signal.aborted) throw new CuaProcessError("cancelled", "not-sent");
      await waitBeforeCuaSend(
        dependencies.authorize({ action, scope, signal }),
        signal,
      );
    }
    if (signal?.aborted && action.operation !== "session.close")
      throw new CuaProcessError("cancelled", "not-sent");
    let data: Extract<ComputerUseResultContent, { status: "ok" }>["data"];
    switch (action.operation) {
      case "capabilities.get":
        data = await service.capabilities(scope, signal);
        break;
      case "targets.list":
        data = { targets: await service.targets(scope, signal) };
        break;
      case "session.open":
        data = {
          session: await (dependencies.openSession
            ? dependencies.openSession(scope, target(action), signal)
            : service.open(scope, target(action), signal)),
        };
        break;
      case "session.state":
        data = { session: service.state(scope, action.sessionId) };
        break;
      case "target.attach":
        data = {
          session: await service.attach(
            scope,
            action.sessionId,
            target(action),
            signal,
          ),
        };
        break;
      case "target.detach":
        data = {
          session: await service.detach(scope, action.sessionId, signal),
        };
        break;
      case "cursor.configure":
        data = {
          session: await service.configure(
            scope,
            action.sessionId,
            target(action),
            action.appearance,
            signal,
          ),
        };
        break;
      case "cursor.move":
        data = {
          session: await service.move(
            scope,
            action.sessionId,
            target(action),
            action.position,
            signal,
          ),
        };
        break;
      case "observation.snapshot": {
        const snapshot = await service.snapshot(
          scope,
          action.sessionId,
          target(action),
          signal,
        );
        payload = snapshot.payload;
        data = { session: snapshot.session, image: snapshot.image };
        break;
      }
      case "session.close":
        service.stopSession(scope, action.sessionId);
        data = { closed: true };
        break;
    }
    result = {
      status: "ok",
      operation: action.operation,
      data,
      chunkCount: payload ? Math.ceil(payload.length / CUA_CHUNK_BYTES) : 0,
    };
  } catch (error) {
    // Do not let native/validation messages escape into generic worker logging.
    // Only these fixed worker-owned errors may contribute a protected message.
    const known =
      error instanceof CuaAuthorizationError ||
      error instanceof CuaServiceError ||
      error instanceof CuaProcessError ||
      error instanceof CuaNativeError;
    result = {
      status: "error",
      operation: context.operation,
      code: known ? error.code : "operation-failed",
      message: known
        ? error.message
        : "Computer-use operation could not be completed or authenticated.",
      outcome: error instanceof CuaProcessError ? error.outcome : "rejected",
    };
  }
  try {
    const response = await protectComputerUseResult({
      context,
      result,
      payload,
      seal,
      emit: async (event) => {
        if (signal?.aborted && result.status === "ok")
          throw new CuaProcessError("cancelled");
        await emit(event);
      },
    });
    if (
      signal?.aborted &&
      result.status === "ok" &&
      context.operation !== "session.close"
    )
      throw new CuaProcessError("cancelled");
    return response;
  } catch {
    // Ciphertext delivery/encryption failures must not expose native context.
    throw new Error("Protected computer-use response could not be delivered.");
  } finally {
    if (payload) clearSensitiveBytes(payload);
  }
}

function target(action: { targetId: string; targetGeneration: number }) {
  return {
    targetId: action.targetId,
    targetGeneration: action.targetGeneration,
  };
}
