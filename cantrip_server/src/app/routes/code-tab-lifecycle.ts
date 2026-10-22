import {
  codeTabWireSummarySchema,
  worktreeSelectionSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";
import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";

interface NativeCodeTabDependencies {
  applicationOwnerId(): string;
  repository: Pick<
    ServerRepository,
    "getCodeTabExecutionContext" | "updateCodeTabWorktree" | "deleteCodeTab"
  >;
  requireProjectWorktrees(projectId: string): Promise<unknown>;
}

export function installCodeTabWorktreeRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    repository,
    requireProjectWorktrees,
  }: NativeCodeTabDependencies,
): void {
  app.patch<{ Params: { codeTabId: string } }>(
    "/api/code-tabs/:codeTabId/worktree",
    async (request, reply) => {
      const input = worktreeSelectionSchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      const ownerId = applicationOwnerId();
      const context = await repository.getCodeTabExecutionContext(
        ownerId,
        request.params.codeTabId,
      );
      if (context) await requireProjectWorktrees(context.codeTab.projectId);
      try {
        const tab = await repository.updateCodeTabWorktree(
          ownerId,
          request.params.codeTabId,
          input.data,
        );
        return tab
          ? reply.send(codeTabWireSummarySchema.parse(tab))
          : reply.code(404).send({ error: "Code tab or worktree not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );
}

export function installCodeTabDeleteRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    repository,
  }: Pick<NativeCodeTabDependencies, "applicationOwnerId" | "repository">,
): void {
  app.delete<{ Params: { codeTabId: string } }>(
    "/api/code-tabs/:codeTabId",
    async (request, reply) =>
      (await repository.deleteCodeTab(
        applicationOwnerId(),
        request.params.codeTabId,
      ))
        ? reply.code(204).send()
        : reply.code(404).send({ error: "Code tab not found." }),
  );
}
