import {
  cuaPreviewAuthoritySchema,
  cuaPreviewLeaseSchema,
  cuaPreviewStopSchema,
  type CuaPreviewAuthority,
  type CuaPreviewRevocation,
} from "@cantrip/protocol/computer-use-preview";
import type { FastifyInstance } from "fastify";

import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import type {
  ChatExecutionContext,
  ServerRepository,
} from "../../db/repository.js";
import {
  WorkerUnavailableError,
  type WorkerCommandBus,
} from "../../workers/bridge.js";

export interface ComputerUseApprovalPublicationScope {
  ownerId: string;
  workerId: string;
  chatId: string;
  requestKey: string;
}

/**
 * Serializes a local terminal notification behind its already-started insert.
 * Entries contain completion promises only, never protected approval payloads.
 * A request timeout must not evict an insert that can still commit afterwards.
 */
export function createComputerUseApprovalPublications() {
  const pending = new Map<string, Promise<void>>();
  const commands = new Map<string, Set<Promise<void>>>();
  let commandCount = 0;
  const commandKey = (
    scope: Omit<ComputerUseApprovalPublicationScope, "requestKey">,
  ) => JSON.stringify([scope.ownerId, scope.workerId, scope.chatId]);
  const key = (scope: ComputerUseApprovalPublicationScope) =>
    JSON.stringify([
      scope.ownerId,
      scope.workerId,
      scope.chatId,
      scope.requestKey,
    ]);
  return {
    beginCommand(
      scope: Omit<ComputerUseApprovalPublicationScope, "requestKey">,
    ): () => void {
      if (commandCount >= 256)
        throw new Error("Computer-use approval publication is unavailable.");
      const id = commandKey(scope);
      const active = commands.get(id) ?? new Set<Promise<void>>();
      let resolve!: () => void;
      const completion = new Promise<void>((accept) => {
        resolve = accept;
      });
      active.add(completion);
      commands.set(id, active);
      commandCount += 1;
      return () => {
        if (!active.delete(completion)) return;
        if (!active.size) commands.delete(id);
        commandCount -= 1;
        resolve();
      };
    },
    async waitCommands(
      scope: Omit<ComputerUseApprovalPublicationScope, "requestKey">,
    ): Promise<void> {
      // Snapshot only commands already dispatched. Future commands never
      // extend a notification's wait or borrow its authority.
      await Promise.all([...(commands.get(commandKey(scope)) ?? [])]);
    },
    publish<T>(
      scope: ComputerUseApprovalPublicationScope,
      operation: () => Promise<T>,
    ): Promise<T> {
      const id = key(scope);
      if (pending.has(id) || pending.size >= 256)
        return Promise.reject(
          new Error("Computer-use approval publication is unavailable."),
        );
      // Insert the completion fence synchronously, before invoking the write.
      const result = Promise.resolve().then(operation);
      const completion = result.then(
        () => undefined,
        () => undefined,
      );
      pending.set(id, completion);
      void completion.finally(() => pending.delete(id));
      return result;
    },
    async wait(scope: ComputerUseApprovalPublicationScope): Promise<void> {
      await pending.get(key(scope));
    },
  };
}

export type ComputerUseApprovalPublications = ReturnType<
  typeof createComputerUseApprovalPublications
>;

function closedResponse(value: unknown): { closed: true } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("closed" in value) ||
    value.closed !== true
  )
    throw new Error("Invalid computer-use close acknowledgment.");
  return { closed: true };
}

/** Reads actual persistent placement and policy; never accepts client claims. */
export function computerUsePreviewAuthority(input: {
  ownerId: string;
  serverId: string;
  context: ChatExecutionContext;
}): CuaPreviewAuthority {
  const { context } = input;
  const profile = effectivePermissionProfile(context);
  return cuaPreviewAuthoritySchema.parse({
    ownerId: input.ownerId,
    serverId: input.serverId,
    workerId: context.workerId,
    chatId: context.chatId,
    projectId: context.projectId,
    contextKind: context.contextKind,
    placementId:
      context.contextKind === "project"
        ? context.worktreeId
        : context.scratchRootId,
    generation: context.computerUseAuthorityGeneration,
    profile: {
      selectedId: profile.selectedId,
      effectiveId: profile.effectiveId,
      forcedByWorktreePolicy: profile.forcedByWorktreePolicy,
      usesDefault: profile.usesDefault,
    },
  });
}

export interface ComputerUsePreviewRouteDependencies {
  applicationOwnerId: () => string;
  serverId: string;
  repository: Pick<ServerRepository, "getChatExecutionContext" | "getWorker">;
  bridge: Pick<WorkerCommandBus, "request">;
}

/** Registration is inert. Only an explicit request creates a worker lease. */
export function installComputerUsePreviewRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    serverId,
    repository,
    bridge,
  }: ComputerUsePreviewRouteDependencies,
): void {
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/computer-use/preview",
    async (request, reply) => {
      const body = request.body ?? {};
      if (
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 0
      )
        return reply
          .code(400)
          .send({ error: "Invalid computer-use preview request." });
      try {
        const ownerId = applicationOwnerId();
        const context = await repository.getChatExecutionContext(
          ownerId,
          request.params.chatId,
        );
        if (!context) return reply.code(404).send({ error: "Chat not found." });
        const authority = computerUsePreviewAuthority({
          ownerId,
          serverId,
          context,
        });
        const lease = cuaPreviewLeaseSchema.parse(
          await bridge.request(
            context.workerId,
            { type: "computer-use.preview.open", authority },
            { ownerId, timeoutMs: 30_000 },
          ),
        );
        if (
          lease.workerId !== authority.workerId ||
          lease.chatId !== authority.chatId ||
          lease.generation !== authority.generation
        )
          throw new Error("Invalid preview lease.");
        return reply.send(lease);
      } catch (error) {
        return reply
          .code(error instanceof WorkerUnavailableError ? 503 : 502)
          .send({ error: "Computer-use preview could not be opened." });
      }
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/computer-use/preview/stop",
    async (request, reply) => {
      const input = cuaPreviewStopSchema.safeParse(request.body);
      if (!input.success)
        return reply
          .code(400)
          .send({ error: "Invalid computer-use Stop request." });
      try {
        const ownerId = applicationOwnerId();
        // Stop targets an already-owned lease, including after chat archival or
        // relocation. The worker authenticates owner/chat/lease as one binding.
        const worker = await repository.getWorker(ownerId, input.data.workerId);
        if (!worker)
          return reply.code(404).send({ error: "Worker not found." });
        const closed = closedResponse(
          await bridge.request(
            worker.workerId,
            {
              type: "computer-use.preview.stop",
              ownerId,
              serverId,
              chatId: request.params.chatId,
              leaseId: input.data.leaseId,
            },
            { ownerId, timeoutMs: 30_000 },
          ),
        );
        return reply.send(closed);
      } catch (error) {
        return reply
          .code(error instanceof WorkerUnavailableError ? 503 : 409)
          .send({ error: "Computer-use preview could not be stopped." });
      }
    },
  );
}

/** Caller supplies only worker IDs resolved from its actual mutation scope. */
export async function revokeComputerUsePreviews(input: {
  bridge: Pick<WorkerCommandBus, "request">;
  ownerId: string;
  serverId: string;
  workerIds: readonly string[];
  scope: CuaPreviewRevocation;
}): Promise<void> {
  const results = await Promise.allSettled(
    [...new Set(input.workerIds)].map((workerId) =>
      input.bridge
        .request(
          workerId,
          {
            type: "computer-use.preview.revoke",
            ownerId: input.ownerId,
            serverId: input.serverId,
            scope: input.scope,
          },
          { ownerId: input.ownerId, timeoutMs: 2_000 },
        )
        .then(closedResponse),
    ),
  );
  if (results.some((result) => result.status === "rejected"))
    throw new Error("Computer-use revocation could not reach every worker.");
}
