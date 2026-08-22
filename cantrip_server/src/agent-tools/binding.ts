import type {
  CantripAgentOperationName,
  CantripMcpBinding,
} from "@cantrip/protocol";
import {
  CANTRIP_MCP_MUTATION_OPERATIONS,
  cantripMcpBindingReadinessSchema,
  cantripMcpOperationsForPermissionProfile,
  isCantripMcpMutationOperation,
} from "@cantrip/protocol";

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

export function cantripMcpBindingReadiness(options: {
  binding: CantripMcpBinding;
  context: ChatExecutionContext;
  serverAllowedOperations: ReadonlySet<CantripAgentOperationName>;
}) {
  const { binding, context } = options;
  const currentPermissionProfile =
    effectivePermissionProfile(context).effectiveId;
  const staleClaims = [
    binding.chatId !== context.chatId ? "chat" : null,
    binding.projectId !== context.projectId ? "project" : null,
    binding.workerId !== context.workerId ? "worker" : null,
    binding.executionLaneId !== context.executionLaneId
      ? "execution-lane"
      : null,
    binding.worktreeId !== context.worktreeId ? "worktree" : null,
    binding.rootKind !== context.rootKind ? "root-kind" : null,
    binding.permissionProfileId !== currentPermissionProfile
      ? "permission-profile"
      : null,
    !chatIsExecuting(context.status) ? "chat-status" : null,
  ].filter((claim): claim is NonNullable<typeof claim> => claim !== null);
  const permitted = new Set(
    cantripMcpOperationsForPermissionProfile(currentPermissionProfile),
  );
  const mutationAuthorized = CANTRIP_MCP_MUTATION_OPERATIONS.some(
    (operation) =>
      binding.allowedOperations.includes(operation) &&
      options.serverAllowedOperations.has(operation) &&
      permitted.has(operation),
  );
  const status =
    staleClaims.length > 0
      ? "refresh-required"
      : mutationAuthorized
        ? "ready"
        : "read-only";
  return cantripMcpBindingReadinessSchema.parse({
    status,
    mutationReady: status === "ready",
    staleClaims,
    recoveryInstruction:
      status === "refresh-required"
        ? "Do not retry mutations on this attachment. Start or resume a turn in the active Cantrip chat to refresh it."
        : status === "read-only"
          ? "This attachment is read-only. Select a write-capable permission profile and start a new turn to enable mutations."
          : null,
    expiresAt: binding.expiresAt,
  });
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
  const staleIdentityClaims = [
    binding.chatId !== context.chatId ? "chat" : null,
    binding.projectId !== context.projectId ? "project" : null,
    binding.workerId !== context.workerId ? "worker" : null,
  ].filter((claim): claim is string => claim !== null);
  // The worktree ID is the durable execution-root identity shared by the
  // worker and server. A canonical filesystem path is worker-private, while
  // the server stores only a field-scoped routing handle, so path strings must
  // never be transported in or compared through an MCP binding.
  const staleScopeClaims = [
    binding.executionLaneId !== context.executionLaneId
      ? "execution lane"
      : null,
    binding.worktreeId !== context.worktreeId ? "worktree" : null,
    binding.rootKind !== context.rootKind ? "root kind" : null,
    binding.permissionProfileId !== currentPermissionProfile
      ? "permission profile"
      : null,
  ].filter((claim): claim is string => claim !== null);
  const staleClaims = [
    ...staleIdentityClaims,
    ...(isCantripMcpMutationOperation(operation) ? staleScopeClaims : []),
  ];
  // Read-only discovery follows the active lane after a safe Cantrip
  // transition. The request remains bound to the same owner, chat, project,
  // and worker, and the current permission profile is independently checked
  // below. Mutations retain exact lane, worktree, root, and permission claims.
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
