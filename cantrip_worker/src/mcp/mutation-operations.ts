import { randomUUID } from "node:crypto";

import {
  browserWireSummarySchema,
  cantripMcpBrowserNavigateInputSchema,
  cantripMcpBrowserNavigateResultSchema,
  cantripMcpExplorerWriteInputSchema,
  cantripMcpExplorerWriteResultSchema,
  cantripMcpTerminalRestartInputSchema,
  cantripMcpTerminalRestartResultSchema,
  cantripMcpTerminalSendInputSchema,
  cantripMcpTerminalSendResultSchema,
  cantripMcpWorktreeCreateInputSchema,
  cantripMcpWorktreeCreateResultSchema,
  cantripMcpWorktreeReleaseInputSchema,
  cantripMcpWorktreeReleaseResultSchema,
  cantripMcpWorktreeRemoveInputSchema,
  cantripMcpWorktreeRemoveResultSchema,
  cantripMcpWorktreeSwitchInputSchema,
  cantripMcpWorktreeSwitchResultSchema,
  chatExecutionLaneSummarySchema,
  executionTargetResolutionSchema,
  executionTargetSchema,
  projectWorktreeSummarySchema,
  worktreeRemoveResultSchema,
  type CantripAgentOperationResult,
} from "@cantrip/protocol";
import {
  explorerOperationRequestContentSchema,
  surfaceOperationOutcomeContentSchema,
  surfaceStreamWireResponseSchema,
  terminalInputContentSchema,
} from "@cantrip/protocol/surface-stream";

import { CantripServerRequestError } from "../cli-client.js";
import { encodeSurfacePrivateStateForWorker } from "../surface-private-state-encryption.js";
import {
  openWorkerSurfaceStreamContent,
  protectWorkerSurfaceStreamContent,
} from "../surface-stream-encryption.js";
import {
  dataRecord,
  resolveSurfaceContext,
  safeWorktree,
  type CantripMcpOperationOptions,
} from "./read-operations.js";

function exactWorktreeTarget(projectId: string, worktreeId: string) {
  return {
    kind: "worktree" as const,
    projectId,
    worktreeId,
  };
}

async function resolveWorktreeTarget(
  options: CantripMcpOperationOptions,
  target: ReturnType<typeof exactWorktreeTarget>,
) {
  if (target.projectId !== options.binding.projectId) {
    throw new Error("The worktree target belongs to a different project.");
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
    resolvedTarget.kind !== "worktree" ||
    JSON.stringify(resolvedTarget) !== JSON.stringify(target) ||
    JSON.stringify(resolution.target) !== JSON.stringify(target) ||
    resolution.availability !== "available" ||
    resolution.placement.projectId !== options.binding.projectId ||
    resolution.placement.worktreeId !== target.worktreeId
  ) {
    throw new Error("The worktree target is no longer available.");
  }
  return target;
}

function normalizedTransition(result: CantripAgentOperationResult) {
  const raw = dataRecord(result);
  const lane = chatExecutionLaneSummarySchema.parse(raw.lane);
  const worktree = projectWorktreeSummarySchema.parse(raw.worktree);
  if (
    lane.worktreeId !== worktree.id ||
    (lane.transitionKind !== "switch" && lane.transitionKind !== "release")
  ) {
    throw new Error("Cantrip returned a malformed worktree transition.");
  }
  return {
    lane: {
      id: lane.id,
      state: lane.state,
      transitionKind: lane.transitionKind,
    },
    worktree: safeWorktree(worktree),
  };
}

async function executeWorktreeOperation(options: CantripMcpOperationOptions) {
  switch (options.request.operation) {
    case "worktree.create": {
      const arguments_ = cantripMcpWorktreeCreateInputSchema.parse(
        options.request.arguments,
      );
      const result = await options.execute(
        options.binding,
        { operation: "worktree.create", arguments: arguments_ },
        options.requestId,
      );
      const worktree = projectWorktreeSummarySchema.parse(result.data);
      if (
        worktree.projectId !== options.binding.projectId ||
        worktree.workerId !== options.binding.workerId ||
        worktree.origin !== "agent"
      ) {
        throw new Error("Cantrip created a worktree outside the MCP binding.");
      }
      const target = exactWorktreeTarget(worktree.projectId, worktree.id);
      return cantripMcpWorktreeCreateResultSchema.parse({
        ...result,
        target,
        worktreeId: worktree.id,
        continuationScheduled: false,
        mutated: true,
        data: { worktree: safeWorktree(worktree) },
      });
    }
    case "worktree.switch": {
      const arguments_ = cantripMcpWorktreeSwitchInputSchema.parse(
        options.request.arguments,
      );
      const target = await resolveWorktreeTarget(options, arguments_.target);
      const result = await options.execute(
        options.binding,
        {
          operation: "worktree.switch",
          arguments: { target, purpose: arguments_.purpose },
        },
        options.requestId,
      );
      return cantripMcpWorktreeSwitchResultSchema.parse({
        ...result,
        target,
        worktreeId: target.worktreeId,
        continuationScheduled: true,
        mutated: true,
        data: normalizedTransition(result),
      });
    }
    case "worktree.release": {
      const arguments_ = cantripMcpWorktreeReleaseInputSchema.parse(
        options.request.arguments,
      );
      const result = await options.execute(
        options.binding,
        { operation: "worktree.release", arguments: arguments_ },
        options.requestId,
      );
      const transition = normalizedTransition(result);
      const target = exactWorktreeTarget(
        options.binding.projectId,
        transition.worktree.id,
      );
      return cantripMcpWorktreeReleaseResultSchema.parse({
        ...result,
        target,
        worktreeId: target.worktreeId,
        continuationScheduled: true,
        mutated: true,
        data: transition,
      });
    }
    case "worktree.remove": {
      const arguments_ = cantripMcpWorktreeRemoveInputSchema.parse(
        options.request.arguments,
      );
      const target = await resolveWorktreeTarget(options, arguments_.target);
      const result = await options.execute(
        options.binding,
        { operation: "worktree.remove", arguments: { target } },
        options.requestId,
      );
      worktreeRemoveResultSchema.parse(result.data);
      return cantripMcpWorktreeRemoveResultSchema.parse({
        ...result,
        target,
        worktreeId: target.worktreeId,
        continuationScheduled: false,
        mutated: true,
        data: {
          removedWorktreeId: target.worktreeId,
          branchRetained: true,
        },
      });
    }
    default:
      throw new Error("The requested operation is not a worktree mutation.");
  }
}

async function executeExplorerWrite(options: CantripMcpOperationOptions) {
  const arguments_ = cantripMcpExplorerWriteInputSchema.parse(
    options.request.arguments,
  );
  const { serverId, target, worktreeId } = await resolveSurfaceContext(
    options,
    arguments_.target,
  );
  const operationId = randomUUID();
  const sequence = 0;
  const protectedRequest = await protectWorkerSurfaceStreamContent({
    context: {
      serverId,
      surfaceKind: "explorer",
      surfaceId: target.surfaceId,
      operationId,
      direction: "request",
      sequence,
    },
    content: {
      type: "explorer.file.write",
      path: arguments_.path,
      content: arguments_.content,
      version: arguments_.version,
    },
    schema: explorerOperationRequestContentSchema,
    service: options.service,
  });
  const relayed = await options.execute(
    options.binding,
    {
      operation: "explorer.write",
      arguments: { target, operationId, sequence, protectedRequest },
    },
    options.requestId,
  );
  const wire = surfaceStreamWireResponseSchema.parse(relayed.data);
  if (wire.operationId !== operationId || wire.sequence !== sequence) {
    throw new Error("The protected Explorer write response is stale.");
  }
  const outcome = await openWorkerSurfaceStreamContent({
    context: {
      serverId,
      surfaceKind: "explorer",
      surfaceId: target.surfaceId,
      operationId,
      direction: "response",
      sequence,
    },
    opaque: wire.protectedResponse,
    schema: surfaceOperationOutcomeContentSchema,
    service: options.service,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  if (outcome.result.type !== "explorer.file") {
    throw new Error("Explorer returned an unexpected protected write result.");
  }
  const { content: _content, ...file } = outcome.result.value;
  return cantripMcpExplorerWriteResultSchema.parse({
    ...relayed,
    summary: `Saved ${file.path}.`,
    target,
    worktreeId,
    continuationScheduled: false,
    mutated: true,
    data: file,
  });
}

async function executeTerminalSend(options: CantripMcpOperationOptions) {
  const arguments_ = cantripMcpTerminalSendInputSchema.parse(
    options.request.arguments,
  );
  const { serverId, target, worktreeId } = await resolveSurfaceContext(
    options,
    arguments_.target,
  );
  const operationId = randomUUID();
  const sequence = 0;
  const protectedRequest = await protectWorkerSurfaceStreamContent({
    context: {
      serverId,
      surfaceKind: "terminal",
      surfaceId: target.surfaceId,
      operationId,
      direction: "input",
      sequence,
    },
    content: { type: "terminal.input", data: arguments_.data },
    schema: terminalInputContentSchema,
    service: options.service,
  });
  const relayed = await options.execute(
    options.binding,
    {
      operation: "terminal.send",
      arguments: { target, operationId, sequence, protectedRequest },
    },
    options.requestId,
  );
  const wire = surfaceStreamWireResponseSchema.parse(relayed.data);
  if (wire.operationId !== operationId || wire.sequence !== sequence) {
    throw new Error("The protected terminal input response is stale.");
  }
  const outcome = await openWorkerSurfaceStreamContent({
    context: {
      serverId,
      surfaceKind: "terminal",
      surfaceId: target.surfaceId,
      operationId,
      direction: "response",
      sequence,
    },
    opaque: wire.protectedResponse,
    schema: surfaceOperationOutcomeContentSchema,
    service: options.service,
  });
  if (!outcome.ok) throw new Error(outcome.error);
  if (outcome.result.type !== "terminal.input.accepted") {
    throw new Error("Terminal returned an unexpected protected input result.");
  }
  return cantripMcpTerminalSendResultSchema.parse({
    ...relayed,
    summary: "Sent protected terminal input.",
    target,
    worktreeId,
    continuationScheduled: false,
    mutated: true,
    data: { accepted: true },
  });
}

async function executeTerminalRestart(options: CantripMcpOperationOptions) {
  const arguments_ = cantripMcpTerminalRestartInputSchema.parse(
    options.request.arguments,
  );
  const { target, worktreeId } = await resolveSurfaceContext(
    options,
    arguments_.target,
  );
  const result = await options.execute(
    options.binding,
    { operation: "terminal.restart", arguments: { target } },
    options.requestId,
  );
  return cantripMcpTerminalRestartResultSchema.parse({
    ...result,
    target,
    worktreeId,
    continuationScheduled: false,
    mutated: true,
    data: { status: "running" },
  });
}

async function executeBrowserNavigate(options: CantripMcpOperationOptions) {
  const arguments_ = cantripMcpBrowserNavigateInputSchema.parse(
    options.request.arguments,
  );
  const { serverId, stateRevision, target, worktreeId } =
    await resolveSurfaceContext(options, arguments_.target);
  if (stateRevision === null) {
    throw new Error("The browser target has no usable protected state.");
  }
  const url = new URL(arguments_.url).toString();
  const stateProtection = await encodeSurfacePrivateStateForWorker({
    ownerId: options.binding.ownerId,
    context: {
      serverId,
      resource: "browser-row",
      resourceId: target.surfaceId,
      operationId: null,
      recordKind: "browser-state",
    },
    content: {
      version: 1,
      classification: { recordKind: "browser-state" },
      revision: stateRevision + 1,
      url,
    },
    service: options.service,
  });
  const result = await options.execute(
    options.binding,
    {
      operation: "browser.open",
      arguments: {
        target,
        expectedStateRevision: stateRevision,
        stateProtection,
      },
    },
    options.requestId,
  );
  const browser = browserWireSummarySchema.parse(result.data);
  if (
    browser.id !== target.surfaceId ||
    browser.projectId !== options.binding.projectId ||
    browser.stateRevision !== stateRevision + 1
  ) {
    throw new Error("Cantrip returned stale browser navigation state.");
  }
  return cantripMcpBrowserNavigateResultSchema.parse({
    ...result,
    summary: `Navigated the browser to ${url}.`,
    target,
    worktreeId,
    continuationScheduled: false,
    mutated: true,
    data: { url, stateRevision: browser.stateRevision },
  });
}

export async function executeCantripMcpMutationOperation(
  options: CantripMcpOperationOptions,
): Promise<CantripAgentOperationResult> {
  if (options.service.ownerId() !== options.binding.ownerId) {
    throw new Error("Worker encryption belongs to a different MCP owner.");
  }
  switch (options.request.operation) {
    case "worktree.create":
    case "worktree.switch":
    case "worktree.release":
    case "worktree.remove":
      return executeWorktreeOperation(options);
    case "explorer.write":
      return executeExplorerWrite(options);
    case "terminal.send":
      return executeTerminalSend(options);
    case "terminal.restart":
      return executeTerminalRestart(options);
    case "browser.open":
      return executeBrowserNavigate(options);
    default:
      throw new CantripServerRequestError(
        "This Cantrip MCP operation is not implemented by the mutation catalog.",
        403,
        "forbidden",
      );
  }
}
