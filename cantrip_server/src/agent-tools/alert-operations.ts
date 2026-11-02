import {
  agentAlertMutationWireSchema,
  type CantripAgentOperationRequest,
  type CantripAgentOperationResult,
} from "@cantrip/protocol";
import type {
  ChatExecutionContext,
  ServerRepository,
} from "../db/repository.js";
import { CliCommandRequestError } from "./errors.js";

export function createAgentAlertOperations(deps: {
  applicationOwnerId(): string;
  serverId: string;
  repository: ServerRepository;
}) {
  return async (
    context: ChatExecutionContext,
    call: CantripAgentOperationRequest,
  ): Promise<CantripAgentOperationResult> => {
    if (context.contextKind !== "project")
      throw new CliCommandRequestError(
        "invalid",
        403,
        "Alerts require a project Chat.",
      );
    const input = agentAlertMutationWireSchema.parse(call.arguments);
    const aad = input.protectedDetail.context;
    if (
      input.status !==
        (call.operation === "alert.resolve" ? "resolved" : "open") ||
      aad.serverId !== deps.serverId ||
      aad.workerId !== context.workerId ||
      aad.scopeId !== context.chatId ||
      aad.operationId !== input.key ||
      aad.sequence !== input.revision ||
      aad.operation !== "agent-alert"
    ) {
      throw new CliCommandRequestError(
        "invalid",
        403,
        "The Alert payload does not match its authenticated Chat context.",
      );
    }
    const alert = await deps.repository.alerts.applyAgent(
      deps.applicationOwnerId(),
      context,
      input,
    );
    if (!alert)
      throw new CliCommandRequestError(
        "conflict",
        409,
        "The originating Chat execution is no longer active.",
      );
    return {
      summary:
        alert.status === "resolved"
          ? "Project Alert resolved."
          : "Project Alert raised.",
      data: {
        id: alert.id,
        key: input.key,
        status: alert.status,
        revision: alert.sourceRevision,
      },
      mutated: true,
      worktreeId: context.worktreeId,
      target: null,
      continuationScheduled: false,
    };
  };
}
