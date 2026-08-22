import type {
  CantripAgentOperationName,
  CantripMcpBinding,
} from "@cantrip/protocol";
import { cantripMcpOperationsForPermissionProfile } from "@cantrip/protocol";

import {
  chatIsExecuting,
  effectivePermissionProfile,
} from "../chats/execution-helpers.js";
import type { ChatExecutionContext } from "../db/repository.js";

export class CantripMcpBindingError extends Error {
  constructor(
    readonly code:
      | "ambiguous"
      | "conflict"
      | "context-not-found"
      | "expired"
      | "forbidden"
      | "invalid"
      | "not-found"
      | "stale-binding"
      | "unsupported-capability"
      | "unavailable",
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function normalizedWorkerPath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return /^[A-Za-z]:\//u.test(normalized)
    ? normalized.toLocaleLowerCase()
    : normalized || "/";
}

export function assertCantripMcpBinding(options: {
  binding: CantripMcpBinding;
  context: ChatExecutionContext;
  operation: CantripAgentOperationName;
  ownerId: string;
  serverAllowedOperations: ReadonlySet<CantripAgentOperationName>;
  now?: number;
}): void {
  const { binding, context, operation } = options;
  const now = options.now ?? Date.now();
  if (binding.ownerId !== options.ownerId) {
    throw new CantripMcpBindingError(
      "forbidden",
      403,
      "The MCP binding belongs to a different owner.",
    );
  }
  if (Date.parse(binding.issuedAt) > now + 60_000) {
    throw new CantripMcpBindingError(
      "invalid",
      400,
      "The MCP binding issue time is invalid.",
    );
  }
  if (Date.parse(binding.expiresAt) <= now) {
    throw new CantripMcpBindingError(
      "expired",
      401,
      "The MCP binding has expired.",
    );
  }
  if (
    !binding.allowedOperations.includes(operation) ||
    !options.serverAllowedOperations.has(operation)
  ) {
    throw new CantripMcpBindingError(
      "forbidden",
      403,
      "The MCP binding does not authorize that operation.",
    );
  }
  const currentPermissionProfile =
    effectivePermissionProfile(context).effectiveId;
  const staleClaims = [
    binding.chatId !== context.chatId ? "chat" : null,
    binding.projectId !== context.projectId ? "project" : null,
    binding.executionLaneId !== context.executionLaneId
      ? "execution lane"
      : null,
    binding.workerId !== context.workerId ? "worker" : null,
    binding.worktreeId !== context.worktreeId ? "worktree" : null,
    binding.rootKind !== context.rootKind ? "root kind" : null,
    binding.permissionProfileId !== currentPermissionProfile
      ? "permission profile"
      : null,
    normalizedWorkerPath(binding.canonicalRoot) !==
    normalizedWorkerPath(context.cwd)
      ? "working directory"
      : null,
  ].filter((claim): claim is string => claim !== null);
  // A linked Codex console can call the read-only context probe while the
  // Cantrip chat row is between turns. Keep every durable binding claim
  // authoritative, but do not reject that harmless probe solely because the
  // UI-owned execution status is briefly idle. All other MCP operations still
  // require an active Cantrip turn.
  const inactiveOperation =
    operation !== "context.get" && !chatIsExecuting(context.status);
  if (inactiveOperation) staleClaims.push("chat status");
  if (staleClaims.length > 0) {
    throw new CantripMcpBindingError(
      "stale-binding",
      409,
      `The MCP binding no longer matches the active Cantrip chat lane (changed: ${staleClaims.join(", ")}).`,
    );
  }
  if (
    !cantripMcpOperationsForPermissionProfile(
      currentPermissionProfile,
    ).includes(operation)
  ) {
    throw new CantripMcpBindingError(
      "forbidden",
      403,
      "The active permission profile does not authorize that MCP operation.",
    );
  }
}
