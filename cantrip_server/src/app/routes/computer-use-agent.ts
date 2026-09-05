import type { CantripMcpBinding } from "@cantrip/protocol";
import {
  cuaAgentAuthorityRequestSchema,
  cuaAgentAuthoritySchema,
  type CuaAgentAuthority,
} from "@cantrip/protocol/computer-use-agent";
import type { FastifyInstance } from "fastify";

import type { ServerConfig } from "../../config.js";
import type {
  ChatExecutionContext,
  ServerRepository,
} from "../../db/repository.js";
import { authenticateWorkerRequest } from "../../workers/credentials.js";
import type { ApplicationOwnerContext } from "../http/owner-context.js";
import { computerUsePreviewAuthority } from "./computer-use-preview.js";

/** CUA never borrows generic MCP read-only lane-following or cached policy. */
export function resolveComputerUseAgentAuthority(input: {
  binding: CantripMcpBinding;
  context: ChatExecutionContext;
  ownerId: string;
  serverId: string;
  now?: number;
}): CuaAgentAuthority | null {
  const { binding, context } = input;
  const now = input.now ?? Date.now();
  if (
    binding.ownerId !== input.ownerId ||
    Date.parse(binding.issuedAt) > now + 60_000 ||
    Date.parse(binding.expiresAt) <= now ||
    binding.contextKind !== context.contextKind ||
    binding.chatId !== context.chatId ||
    binding.projectId !== context.projectId ||
    binding.scratchRootId !== context.scratchRootId ||
    binding.workerId !== context.workerId ||
    binding.executionLaneId !== context.executionLaneId ||
    binding.worktreeId !== context.worktreeId ||
    binding.rootKind !== context.rootKind
  )
    return null;
  // Deliberately do not infer a native turn from the server chat status or its
  // eventually updated thread ID. The worker must resolve the actual live turn.
  // Policy comes from this read, not the six-hour MCP attachment's profile.
  return cuaAgentAuthoritySchema.parse({
    ...computerUsePreviewAuthority(input),
    executionLaneId: context.executionLaneId,
  });
}

export interface ComputerUseAgentRouteDependencies {
  config: ServerConfig;
  serverId: string;
  repository: Pick<
    ServerRepository,
    "authenticateWorkerCredential" | "getChatExecutionContext"
  >;
  runAsOwner: ApplicationOwnerContext["runAsOwner"];
}

/** Real per-operation authorization; no helper readiness/native permission probe. */
export function installComputerUseAgentRoutes(
  app: FastifyInstance,
  {
    config,
    serverId,
    repository,
    runAsOwner,
  }: ComputerUseAgentRouteDependencies,
): void {
  app.post(
    "/api/internal/computer-use/authority",
    { logLevel: "warn", bodyLimit: 32 * 1024 },
    async (request, reply) => {
      const parsed = cuaAgentAuthorityRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: "Invalid computer-use authority request." });
      const { binding } = parsed.data;
      const authentication = await authenticateWorkerRequest(
        repository,
        config,
        request,
        binding.workerId,
        "worker:agent-tools",
      );
      if (!authentication || authentication.ownerId !== binding.ownerId)
        return reply.code(401).send({ error: "Unauthorized" });
      return runAsOwner(authentication.ownerId, async () => {
        try {
          const context = await repository.getChatExecutionContext(
            authentication.ownerId,
            binding.chatId,
          );
          const authority =
            context &&
            resolveComputerUseAgentAuthority({
              binding,
              context,
              ownerId: authentication.ownerId,
              serverId,
            });
          if (!authority)
            return reply.code(409).send({
              error:
                "Computer-use execution placement is no longer authorized.",
            });
          reply.header("cache-control", "no-store");
          return reply.send(authority);
        } catch {
          // No database/native details, protected paths, or blank authority fallback.
          return reply
            .code(503)
            .send({ error: "Computer-use authorization is unavailable." });
        }
      });
    },
  );
}
