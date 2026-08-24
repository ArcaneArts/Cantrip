import { randomUUID } from "node:crypto";

import {
  cantripMcpBrowserServicesInputSchema,
  cantripMcpBrowserServicesResultSchema,
  cantripMcpContextGetInputSchema,
  cantripMcpContextGetResultSchema,
  cantripMcpExplorerListInputSchema,
  cantripMcpExplorerListResultSchema,
  cantripMcpExplorerReadInputSchema,
  cantripMcpExplorerReadResultSchema,
  cantripMcpPolicyListInputSchema,
  cantripMcpPolicyListResultSchema,
  cantripMcpPolicyReadInputSchema,
  cantripMcpPolicyReadResultSchema,
  cantripMcpTargetInspectInputSchema,
  cantripMcpTargetInspectResultSchema,
  cantripMcpTargetListInputSchema,
  cantripMcpTargetListResultSchema,
  cantripMcpTerminalReadInputSchema,
  cantripMcpTerminalReadResultSchema,
  cantripMcpToolHelpInputSchema,
  cantripMcpWorktreeListInputSchema,
  cantripMcpWorktreeListResultSchema,
  cantripMcpWorktreeStatusInputSchema,
  cantripMcpWorktreeStatusResultSchema,
  browserServiceListSchema,
  chatExecutionLaneListSchema,
  executionTargetCatalogSchema,
  executionTargetResolutionSchema,
  executionTargetSchema,
  executionTargetWireCatalogSchema,
  projectWorktreeListSchema,
  worktreeStatusResultSchema,
  type CantripAgentOperationRequest,
  type CantripAgentOperationResult,
  type CantripMcpBinding,
} from "@cantrip/protocol";
import {
  policyCliWireListResultSchema,
  policyCliWireReadResultSchema,
} from "@cantrip/protocol/policies";
import {
  explorerOperationRequestContentSchema,
  surfaceOperationOutcomeContentSchema,
  surfaceStreamWireResponseSchema,
  terminalSnapshotRequestContentSchema,
} from "@cantrip/protocol/surface-stream";

import { CantripServerRequestError } from "../cli-client.js";
import { decodePrivateDisplayLabelForWorker } from "../private-label-encryption.js";
import {
  openPolicyCliDetail,
  openPolicyCliList,
} from "../policy-encryption.js";
import {
  openWorkerSurfaceStreamContent,
  protectWorkerSurfaceStreamContent,
} from "../surface-stream-encryption.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import { cantripMcpToolHelp } from "./tool-catalog.js";

export type CantripMcpRawOperationExecutor = (
  binding: CantripMcpBinding,
  request: CantripAgentOperationRequest,
  requestId: string,
) => Promise<CantripAgentOperationResult>;

export interface CantripMcpOperationOptions {
  binding: CantripMcpBinding;
  execute: CantripMcpRawOperationExecutor;
  request: CantripAgentOperationRequest;
  requestId: string;
  service: WorkerEncryptionService;
}

export function dataRecord(result: CantripAgentOperationResult) {
  if (!result.data || typeof result.data !== "object") {
    throw new Error("Cantrip returned a malformed operation result.");
  }
  return result.data as Record<string, unknown>;
}

export function safeWorktree<
  T extends { displayPath?: unknown; path?: unknown },
>(worktree: T): Omit<T, "displayPath" | "path"> {
  const { path: _path, displayPath: _displayPath, ...safe } = worktree;
  return safe;
}

export async function resolveSurfaceContext(
  options: CantripMcpOperationOptions,
  target: {
    kind: "surface";
    projectId: string;
    surfaceId: string;
    surfaceKind: "browser" | "explorer" | "terminal";
  },
) {
  const inspected = await options.execute(
    options.binding,
    { operation: "target.inspect", arguments: { target } },
    `${options.requestId}:inspect-target`,
  );
  const resolvedTarget = executionTargetSchema.parse(inspected.target);
  const details = dataRecord(inspected);
  const {
    serverId,
    stateRevision: _stateRevision,
    ...resolutionData
  } = details;
  const resolution = executionTargetResolutionSchema.parse(resolutionData);
  if (
    resolvedTarget.kind !== "surface" ||
    resolvedTarget.surfaceKind !== target.surfaceKind ||
    resolvedTarget.surfaceId !== target.surfaceId ||
    resolvedTarget.projectId !== target.projectId ||
    resolvedTarget.projectId !== options.binding.projectId ||
    JSON.stringify(resolution.target) !== JSON.stringify(resolvedTarget) ||
    resolution.availability !== "available" ||
    typeof serverId !== "string"
  ) {
    throw new Error(
      `The ${target.surfaceKind} target cannot receive protected operations.`,
    );
  }
  return {
    serverId,
    stateRevision:
      Number.isSafeInteger(details.stateRevision) &&
      Number(details.stateRevision) > 0
        ? Number(details.stateRevision)
        : null,
    target: resolvedTarget,
    worktreeId: resolution.placement.worktreeId,
  };
}

async function executePolicyOperation(options: CantripMcpOperationOptions) {
  const listResult = await options.execute(
    options.binding,
    { operation: "policy.list", arguments: {} },
    `${options.requestId}:policy-list`,
  );
  const wire = policyCliWireListResultSchema.parse(listResult.data);
  const opened = await openPolicyCliList({
    policies: wire,
    service: options.service,
  });
  if (options.request.operation === "policy.list") {
    return cantripMcpPolicyListResultSchema.parse({
      ...listResult,
      summary: `Found ${opened.policies.length} effective polic${opened.policies.length === 1 ? "y" : "ies"}.`,
      data: opened,
    });
  }
  const { key } = cantripMcpPolicyReadInputSchema.parse(
    options.request.arguments,
  );
  const index = opened.policies.findIndex((policy) => policy.key === key);
  if (index < 0) {
    throw new CantripServerRequestError(
      `Policy ${key} is not effective for the current project.`,
      404,
      "not-found",
    );
  }
  const detailResult = await options.execute(
    options.binding,
    {
      operation: "policy.read",
      arguments: { policyId: wire.policies[index]!.id },
    },
    `${options.requestId}:policy-read`,
  );
  const detail = policyCliWireReadResultSchema.parse(detailResult.data);
  return cantripMcpPolicyReadResultSchema.parse({
    ...detailResult,
    summary: `Read policy ${key}.`,
    data: await openPolicyCliDetail({
      policy: detail.policy,
      service: options.service,
    }),
  });
}

async function executeTargetList(options: CantripMcpOperationOptions) {
  const arguments_ = cantripMcpTargetListInputSchema.parse(
    options.request.arguments,
  );
  const result = await options.execute(
    options.binding,
    { operation: "target.list", arguments: arguments_ },
    options.requestId,
  );
  const raw = dataRecord(result);
  const wire = executionTargetWireCatalogSchema.parse({
    projectId: raw.projectId,
    targets: raw.targets,
    truncated: raw.truncated,
  });
  const catalog = executionTargetCatalogSchema.parse({
    ...wire,
    targets: await Promise.all(
      wire.targets.map(async ({ titleProtection, ...target }) => {
        if (target.title !== null) return { ...target, title: target.title };
        if (!titleProtection || target.target.kind !== "surface") {
          throw new Error(
            "A protected execution target is missing its protected title.",
          );
        }
        return {
          ...target,
          title: await decodePrivateDisplayLabelForWorker({
            opaque: titleProtection,
            ownerId: options.binding.ownerId,
            recordKind: titleProtection.classification.recordKind,
            rowId: target.target.surfaceId,
            service: options.service,
          }),
        };
      }),
    ),
  });
  return cantripMcpTargetListResultSchema.parse({
    ...result,
    data: {
      projectId: catalog.projectId,
      targets: catalog.targets,
      cursor: raw.cursor,
      nextCursor: raw.nextCursor,
      total: raw.total,
      truncated: raw.truncated,
    },
  });
}

async function executeTargetInspect(options: CantripMcpOperationOptions) {
  const arguments_ = cantripMcpTargetInspectInputSchema.parse(
    options.request.arguments,
  );
  const result = await options.execute(
    options.binding,
    { operation: "target.inspect", arguments: arguments_ },
    options.requestId,
  );
  const raw = dataRecord(result);
  const { serverId: _serverId, stateRevision, ...resolutionData } = raw;
  const resolution = executionTargetResolutionSchema.parse(resolutionData);
  return cantripMcpTargetInspectResultSchema.parse({
    ...result,
    target: resolution.target,
    data: {
      ...resolution,
      stateRevision:
        Number.isSafeInteger(stateRevision) && Number(stateRevision) > 0
          ? Number(stateRevision)
          : null,
    },
  });
}

async function executeWorktreeList(options: CantripMcpOperationOptions) {
  const arguments_ = cantripMcpWorktreeListInputSchema.parse(
    options.request.arguments,
  );
  const result = await options.execute(
    options.binding,
    { operation: "worktree.list", arguments: arguments_ },
    options.requestId,
  );
  const raw = dataRecord(result);
  const worktrees = projectWorktreeListSchema.parse(raw.worktrees);
  const leases = chatExecutionLaneListSchema.parse(raw.leases);
  return cantripMcpWorktreeListResultSchema.parse({
    ...result,
    data: {
      currentWorktreeId: raw.currentWorktreeId,
      worktrees: worktrees.map((worktree) => safeWorktree(worktree)),
      leases,
      cursor: raw.cursor,
      nextCursor: raw.nextCursor,
      total: raw.total,
      truncated: raw.truncated,
    },
  });
}

async function executeWorktreeStatus(options: CantripMcpOperationOptions) {
  const arguments_ = cantripMcpWorktreeStatusInputSchema.parse(
    options.request.arguments,
  );
  const result = await options.execute(
    options.binding,
    { operation: "worktree.status", arguments: arguments_ },
    options.requestId,
  );
  const raw = dataRecord(result);
  const status = worktreeStatusResultSchema.parse(raw);
  return cantripMcpWorktreeStatusResultSchema.parse({
    ...result,
    data: {
      worktree: safeWorktree(status.worktree),
      status: status.status,
      filesTruncated: raw.filesTruncated,
      branchesTruncated: raw.branchesTruncated,
    },
  });
}

async function executeExplorerOperation(options: CantripMcpOperationOptions) {
  const list = options.request.operation === "explorer.list";
  const arguments_ = list
    ? cantripMcpExplorerListInputSchema.parse(options.request.arguments)
    : cantripMcpExplorerReadInputSchema.parse(options.request.arguments);
  const { serverId, target } = await resolveSurfaceContext(
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
    content: list
      ? { type: "explorer.directory.list" as const, path: arguments_.path }
      : { type: "explorer.file.read" as const, path: arguments_.path },
    schema: explorerOperationRequestContentSchema,
    service: options.service,
  });
  const relayed = await options.execute(
    options.binding,
    {
      operation: options.request.operation,
      arguments: { target, operationId, sequence, protectedRequest },
    },
    options.requestId,
  );
  const wire = surfaceStreamWireResponseSchema.parse(relayed.data);
  if (wire.operationId !== operationId || wire.sequence !== sequence) {
    throw new Error("The protected Explorer response is stale.");
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
  if (list) {
    if (outcome.result.type !== "explorer.directory.list") {
      throw new Error("Explorer returned an unexpected protected result.");
    }
    const input = cantripMcpExplorerListInputSchema.parse(arguments_);
    const directory = outcome.result.value;
    const entries = directory.entries.slice(
      input.cursor,
      input.cursor + input.limit,
    );
    const nextCursor =
      input.cursor + entries.length < directory.entries.length
        ? input.cursor + entries.length
        : null;
    return cantripMcpExplorerListResultSchema.parse({
      ...relayed,
      target,
      summary: `Found ${entries.length} Explorer entr${entries.length === 1 ? "y" : "ies"}.`,
      data: {
        path: directory.path,
        entries,
        cursor: input.cursor,
        nextCursor,
        total: directory.entries.length,
        truncated: directory.truncated || nextCursor !== null,
      },
    });
  }
  if (outcome.result.type !== "explorer.file") {
    throw new Error("Explorer returned an unexpected protected file.");
  }
  const input = cantripMcpExplorerReadInputSchema.parse(arguments_);
  const file = outcome.result.value;
  const truncated = file.content.length > input.maxChars;
  return cantripMcpExplorerReadResultSchema.parse({
    ...relayed,
    target,
    summary: `Read ${file.path}${truncated ? " (content truncated)" : ""}.`,
    data: {
      ...file,
      content: file.content.slice(0, input.maxChars),
      truncated,
    },
  });
}

async function executeTerminalRead(options: CantripMcpOperationOptions) {
  const arguments_ = cantripMcpTerminalReadInputSchema.parse(
    options.request.arguments,
  );
  const { serverId, target } = await resolveSurfaceContext(
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
      direction: "request",
      sequence,
    },
    content: { type: "terminal.snapshot", maxChars: arguments_.maxChars },
    schema: terminalSnapshotRequestContentSchema,
    service: options.service,
  });
  const relayed = await options.execute(
    options.binding,
    {
      operation: "terminal.read",
      arguments: { target, operationId, sequence, protectedRequest },
    },
    options.requestId,
  );
  const wire = surfaceStreamWireResponseSchema.parse(relayed.data);
  if (wire.operationId !== operationId || wire.sequence !== sequence) {
    throw new Error("The protected terminal response is stale.");
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
  if (outcome.result.type !== "terminal.snapshot") {
    throw new Error("Terminal returned an unexpected protected snapshot.");
  }
  const { type: _type, terminalId: _terminalId, ...snapshot } = outcome.result;
  return cantripMcpTerminalReadResultSchema.parse({
    ...relayed,
    target,
    summary: `Terminal is ${snapshot.status}${snapshot.truncated ? "; scrollback was truncated" : ""}.`,
    data: snapshot,
  });
}

export async function executeCantripMcpReadOperation(
  options: CantripMcpOperationOptions,
): Promise<CantripAgentOperationResult> {
  if (options.service.ownerId() !== options.binding.ownerId) {
    throw new Error("Worker encryption belongs to a different MCP owner.");
  }
  switch (options.request.operation) {
    case "tool.help": {
      const { tool } = cantripMcpToolHelpInputSchema.parse(
        options.request.arguments,
      );
      return cantripMcpToolHelp(tool);
    }
    case "context.get": {
      cantripMcpContextGetInputSchema.parse(options.request.arguments);
      return cantripMcpContextGetResultSchema.parse(
        await options.execute(
          options.binding,
          options.request,
          options.requestId,
        ),
      );
    }
    case "policy.list":
      cantripMcpPolicyListInputSchema.parse(options.request.arguments);
      return executePolicyOperation(options);
    case "policy.read":
      return executePolicyOperation(options);
    case "target.list":
      return executeTargetList(options);
    case "target.inspect":
      return executeTargetInspect(options);
    case "worktree.list":
      return executeWorktreeList(options);
    case "worktree.status":
      return executeWorktreeStatus(options);
    case "explorer.list":
    case "explorer.read":
      return executeExplorerOperation(options);
    case "terminal.read":
      return executeTerminalRead(options);
    case "browser.services": {
      const arguments_ = cantripMcpBrowserServicesInputSchema.parse(
        options.request.arguments,
      );
      const result = await options.execute(
        options.binding,
        { operation: "browser.services", arguments: arguments_ },
        options.requestId,
      );
      browserServiceListSchema.parse(result.data);
      return cantripMcpBrowserServicesResultSchema.parse({
        ...result,
        target: arguments_.target,
      });
    }
    default:
      throw new CantripServerRequestError(
        "This Cantrip MCP operation is not implemented by the read-only catalog.",
        403,
        "forbidden",
      );
  }
}
