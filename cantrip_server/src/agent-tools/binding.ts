import type {
  CantripAgentOperationName,
  CantripMcpBinding,
} from "@cantrip/protocol";

import {
  chatIsExecuting,
  effectivePermissionProfile,
} from "../chats/execution-helpers.js";
import type { ChatExecutionContext } from "../db/repository.js";

export class CantripMcpBindingError extends Error {
  constructor(
    readonly code: "expired" | "forbidden" | "invalid" | "stale-binding",
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
  const stale =
    binding.chatId !== context.chatId ||
    binding.projectId !== context.projectId ||
    binding.executionLaneId !== context.executionLaneId ||
    binding.workerId !== context.workerId ||
    binding.worktreeId !== context.worktreeId ||
    binding.rootKind !== context.rootKind ||
    binding.permissionProfileId !== currentPermissionProfile ||
    normalizedWorkerPath(binding.canonicalRoot) !==
      normalizedWorkerPath(context.cwd) ||
    !chatIsExecuting(context.status);
  if (stale) {
    throw new CantripMcpBindingError(
      "stale-binding",
      409,
      "The MCP binding no longer matches the active Cantrip chat lane.",
    );
  }
}
