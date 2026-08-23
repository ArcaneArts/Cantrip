import {
  cantripMcpClientFocusProjectInputSchema,
  cantripMcpClientFocusProjectResultSchema,
  cantripMcpClientFocusSurfaceInputSchema,
  cantripMcpClientFocusSurfaceResultSchema,
  cantripMcpClientNotifyInputSchema,
  cantripMcpClientNotifyResultSchema,
  cantripMcpClientShowInteractionInputSchema,
  cantripMcpClientShowInteractionResultSchema,
  clientControlResultStatusSchema,
  executionTargetResolutionSchema,
  executionTargetSchema,
  protectedClientNotificationSchema,
  type CantripAgentOperationResult,
} from "@cantrip/protocol";

import { protectWorkerClientNotification } from "../client-control-content-encryption.js";
import {
  dataRecord,
  type CantripMcpOperationOptions,
} from "./read-operations.js";

function clientControlData(result: CantripAgentOperationResult) {
  const data = dataRecord(result);
  return {
    correlationId: String(data.correlationId),
    status: clientControlResultStatusSchema.parse(data.status),
  };
}

async function inspectSurface(
  options: CantripMcpOperationOptions,
  target: {
    kind: "surface";
    projectId: string;
    surfaceKind: "browser" | "chat" | "code" | "explorer" | "terminal";
    surfaceId: string;
  },
) {
  if (target.projectId !== options.binding.projectId) {
    throw new Error("The client-control target belongs to another project.");
  }
  const inspected = await options.execute(
    options.binding,
    { operation: "target.inspect", arguments: { target } },
    `${options.requestId}:inspect-target`,
  );
  const resolvedTarget = executionTargetSchema.parse(inspected.target);
  const raw = dataRecord(inspected);
  const {
    serverId: _serverId,
    stateRevision: _stateRevision,
    ...resolutionData
  } = raw;
  const resolution = executionTargetResolutionSchema.parse(resolutionData);
  if (
    JSON.stringify(resolvedTarget) !== JSON.stringify(target) ||
    JSON.stringify(resolution.target) !== JSON.stringify(target) ||
    resolution.availability !== "available" ||
    resolution.placement.projectId !== options.binding.projectId
  ) {
    throw new Error("The client-control target is no longer available.");
  }
  return { target, worktreeId: resolution.placement.worktreeId };
}

export async function executeCantripMcpClientControlOperation(
  options: CantripMcpOperationOptions,
): Promise<CantripAgentOperationResult> {
  switch (options.request.operation) {
    case "client.notify": {
      const arguments_ = cantripMcpClientNotifyInputSchema.parse(
        options.request.arguments,
      );
      const target = {
        kind: "project" as const,
        projectId: options.binding.projectId,
      };
      const notification = protectedClientNotificationSchema.parse({
        operationId: options.requestId,
        protectedContent: await protectWorkerClientNotification({
          content: arguments_,
          operationId: options.requestId,
          projectId: options.binding.projectId,
          service: options.service,
          workerId: options.binding.workerId,
        }),
      });
      const result = await options.execute(
        options.binding,
        { operation: "client.notify", arguments: notification },
        options.requestId,
      );
      const data = clientControlData(result);
      return cantripMcpClientNotifyResultSchema.parse({
        ...result,
        target,
        worktreeId: options.binding.worktreeId,
        continuationScheduled: false,
        mutated: data.status === "applied",
        data,
      });
    }
    case "client.focus-project": {
      const arguments_ = cantripMcpClientFocusProjectInputSchema.parse(
        options.request.arguments,
      );
      const target = {
        kind: "project" as const,
        projectId: options.binding.projectId,
      };
      const result = await options.execute(
        options.binding,
        { operation: "client.focus-project", arguments: arguments_ },
        options.requestId,
      );
      const data = clientControlData(result);
      return cantripMcpClientFocusProjectResultSchema.parse({
        ...result,
        target,
        worktreeId: options.binding.worktreeId,
        continuationScheduled: false,
        mutated: data.status === "applied",
        data,
      });
    }
    case "client.focus-surface": {
      const arguments_ = cantripMcpClientFocusSurfaceInputSchema.parse(
        options.request.arguments,
      );
      const { target, worktreeId } = await inspectSurface(
        options,
        arguments_.target,
      );
      const result = await options.execute(
        options.binding,
        { operation: "client.focus-surface", arguments: { target } },
        options.requestId,
      );
      const data = clientControlData(result);
      return cantripMcpClientFocusSurfaceResultSchema.parse({
        ...result,
        target,
        worktreeId,
        continuationScheduled: false,
        mutated: data.status === "applied",
        data,
      });
    }
    case "client.show-interaction": {
      const arguments_ = cantripMcpClientShowInteractionInputSchema.parse(
        options.request.arguments,
      );
      const result = await options.execute(
        options.binding,
        {
          operation: "client.show-interaction",
          arguments: arguments_,
        },
        options.requestId,
      );
      const target = {
        kind: "surface" as const,
        projectId: options.binding.projectId,
        surfaceKind: "chat" as const,
        surfaceId: options.binding.chatId,
      };
      const data = clientControlData(result);
      return cantripMcpClientShowInteractionResultSchema.parse({
        ...result,
        target,
        worktreeId: options.binding.worktreeId,
        continuationScheduled: false,
        mutated: data.status === "applied",
        data,
      });
    }
    default:
      throw new Error("The requested operation is not a client control.");
  }
}
