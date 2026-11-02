import {
  agentAlertMutationWireSchema,
  cantripMcpAlertRaiseInputSchema,
  cantripMcpAlertResolveInputSchema,
  projectAlertDetailSchema,
  type CantripAgentOperationResult,
} from "@cantrip/protocol";
import { protectWorkerEndpointContent } from "../endpoint-content-encryption.js";
import type { CantripMcpOperationOptions } from "./read-operations.js";

export async function executeCantripMcpAlertOperation(
  options: CantripMcpOperationOptions,
): Promise<CantripAgentOperationResult> {
  if (
    options.binding.contextKind !== "project" ||
    options.service.ownerId() !== options.binding.ownerId
  )
    throw new Error("Alerts require the current project’s authorized worker.");
  const resolving = options.request.operation === "alert.resolve";
  const raised = resolving
    ? null
    : cantripMcpAlertRaiseInputSchema.parse(options.request.arguments);
  const input =
    raised ??
    cantripMcpAlertResolveInputSchema.parse(options.request.arguments);
  const detail = projectAlertDetailSchema.parse(
    raised
      ? {
          title: raised.title,
          message: raised.message,
          nextStep: raised.nextStep,
        }
      : {
          title: "Alert resolved",
          message: "The originating agent resolved this Alert.",
          nextStep: "",
        },
  );
  const context = {
    domain: "alert-content" as const,
    serverId: options.service.serverIdentity(),
    workerId: options.binding.workerId,
    scopeId: options.binding.chatId,
    operationId: input.key,
    operation: "agent-alert",
    direction: "stored" as const,
    sequence: input.revision,
  };
  const wire = agentAlertMutationWireSchema.parse({
    key: input.key,
    revision: input.revision,
    kind: raised?.kind ?? "blocked",
    status: resolving ? "resolved" : "open",
    protectedDetail: {
      context,
      protectedContent: await protectWorkerEndpointContent({
        context,
        content: detail,
        schema: projectAlertDetailSchema,
        service: options.service,
      }),
    },
  });
  return options.execute(
    options.binding,
    { operation: resolving ? "alert.resolve" : "alert.raise", arguments: wire },
    options.requestId,
  );
}
