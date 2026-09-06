import { randomUUID } from "node:crypto";
import type {
  AgentActivity,
  AgentScope,
  CuaImage,
  CuaInputReceipt,
  CuaPoint,
  CuaSession,
  CuaScope,
  CuaTargetReference,
} from "@cantrip/protocol";
import { createAgentActivityRawEnvelope } from "../codex/raw-capture.js";
import { CuaApprovalError } from "./approvals.js";
import { CuaAuthorizationError } from "./handler.js";
import { CuaNativeError, CuaProcessError } from "./errors.js";
import { CuaServiceError } from "./service.js";

export type CuaActivity = Extract<AgentActivity, { type: "computerUse" }>;
export type CuaActivityPublisher = (activity: CuaActivity) => void;

/** Build one terminal record from worker-owned metadata only. Never pass a JS
 * source, native inventory, raw error message, or image payload to raw capture. */
export function computerUseActivity(input: {
  source: CuaActivity["source"];
  operation: CuaActivity["operation"];
  operationId: string;
  requestId: string | null;
  scope: CuaScope;
  session?: CuaSession | null;
  target?: CuaTargetReference | null;
  image?: CuaImage | null;
  input?: CuaInputReceipt | null;
  inputMethod?: CuaInputReceipt["method"];
  position?: CuaPoint | null;
  startedAtMs: number;
  completedAtMs?: number;
  agentScope?: AgentScope | null;
  itemId?: string | null;
  error?: unknown;
  failed?: boolean;
  cancelled?: boolean;
}): CuaActivity {
  const completedAtMs = input.completedAtMs ?? Date.now();
  const error = input.error;
  const code =
    error instanceof CuaApprovalError ||
    error instanceof CuaAuthorizationError ||
    error instanceof CuaNativeError ||
    error instanceof CuaProcessError ||
    error instanceof CuaServiceError
      ? error.code
      : input.failed
        ? "operation-failed"
        : null;
  const outcome =
    input.cancelled ||
    code === "cancelled" ||
    code === "revoked" ||
    code === "closed"
      ? "cancelled"
      : code === "denied"
        ? "declined"
        : input.failed
          ? "failed"
          : "completed";
  const { chatId, taskId, workerId, threadId, turnId } = input.scope;
  const session = input.session;
  return {
    id: randomUUID(),
    type: "computerUse",
    status: outcome === "cancelled" ? "failed" : outcome,
    startedAtMs: input.startedAtMs,
    updatedAtMs: completedAtMs,
    completedAtMs,
    source: input.source,
    operation: input.operation,
    operationId: input.operationId,
    requestId: input.requestId,
    binding: {
      chatId,
      taskId,
      workerId,
      threadId,
      turnId,
      sessionId: session?.binding.sessionId ?? null,
    },
    target:
      input.target ??
      (session?.target
        ? {
            targetId: session.target.id,
            targetGeneration: session.target.generation,
          }
        : null),
    input:
      input.input ??
      (input.operation === "input.press" || input.operation === "input.click"
        ? {
            method: input.inputMethod ?? "accessibility",
            activation: input.inputMethod === "coordinate" ? null : false,
            ...(input.position ? { position: input.position } : {}),
            outcome:
              code === "input-unknown" ||
              (error instanceof CuaProcessError && error.outcome === "unknown")
                ? "unknown"
                : code === "unsupported"
                  ? "unsupported"
                  : outcome === "completed"
                    ? "dispatched"
                    : outcome,
          }
        : null),
    cursor: session ? structuredClone(session.cursor) : null,
    observation:
      input.image && session
        ? {
            revision: session.observationRevision,
            image: structuredClone(input.image),
          }
        : null,
    outcome,
    errorCode: code,
    durationMs: Math.max(0, completedAtMs - input.startedAtMs),
    correlation: {
      sourceMethod: `computer-use/${input.operation}`,
      diagnosticId: input.operationId,
      threadId,
      turnId,
      itemId: input.itemId ?? null,
    },
    ...(input.agentScope
      ? { agentScope: structuredClone(input.agentScope) }
      : {}),
    raw: createAgentActivityRawEnvelope({
      metadata: {
        source: input.source,
        operation: input.operation,
        operationId: input.operationId,
        outcome,
        errorCode: code,
        durationMs: Math.max(0, completedAtMs - input.startedAtMs),
      },
    }),
  };
}
