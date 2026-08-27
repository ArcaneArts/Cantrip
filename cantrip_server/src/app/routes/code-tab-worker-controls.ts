import {
  codeRuntimeStatusSchema,
  codeSaveAllResultSchema,
  codeTabWireSummarySchema,
  codeThemeUpdateSchema,
  type CodeRuntimeStatus,
  type CodeThemeUpdate,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";

export interface CodeTabWorkerRuntime {
  isWorkerConnected: (workerId: string) => boolean;
  readStatus: (workerId: string, sessionId: string) => Promise<unknown>;
  saveAll: (workerId: string, sessionId: string) => Promise<unknown>;
  stop: (workerId: string, sessionId: string) => Promise<unknown>;
  setTheme: (
    workerId: string,
    sessionId: string,
    appearance: CodeThemeUpdate["appearance"],
  ) => Promise<unknown>;
  revokeTunnelSession: (sessionId: string) => Promise<void>;
  revokeDirectSession: (ownerId: string, sessionId: string) => Promise<void>;
  recordSessionRuntime: (
    ownerId: string,
    codeTabId: string,
    sessionId: string,
    runtime: CodeRuntimeStatus,
  ) => Promise<unknown>;
}

export interface CodeTabWorkerControlRouteDependencies {
  applicationOwnerId: () => string;
  repository: Pick<
    ServerRepository,
    "getCodeTabExecutionContext" | "listCodeSessions" | "updateCodeTab"
  >;
  runtime: CodeTabWorkerRuntime;
}

/** Registers the worker-backed session status read before attachment routes. */
export function installCodeTabRuntimeReadRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    repository,
    runtime,
  }: CodeTabWorkerControlRouteDependencies,
): void {
  app.get<{ Params: { codeTabId: string; sessionId: string } }>(
    "/api/code-tabs/:codeTabId/sessions/:sessionId/runtime",
    async (request, reply) => {
      const context = await repository.getCodeTabExecutionContext(
        applicationOwnerId(),
        request.params.codeTabId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Code tab not found." });
      }
      const sessions =
        (await repository.listCodeSessions(
          applicationOwnerId(),
          request.params.codeTabId,
        )) ?? [];
      const session = sessions.find(
        (candidate) => candidate.id === request.params.sessionId,
      );
      if (!session) {
        return reply.code(404).send({ error: "Code session not found." });
      }
      if (!runtime.isWorkerConnected(context.workerId)) {
        return reply.code(503).send({ error: "Worker is offline." });
      }
      try {
        const status = codeRuntimeStatusSchema.parse(
          await runtime.readStatus(context.workerId, session.id),
        );
        await runtime.recordSessionRuntime(
          applicationOwnerId(),
          context.codeTab.id,
          session.id,
          status,
        );
        return reply.send(status);
      } catch (error) {
        return reply.code(502).send({ error: errorMessage(error) });
      }
    },
  );
}

/** Registers Code worker controls after protected attachment lifecycle routes. */
export function installCodeTabWorkerControlRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    repository,
    runtime,
  }: CodeTabWorkerControlRouteDependencies,
): void {
  app.post<{ Params: { codeTabId: string } }>(
    "/api/code-tabs/:codeTabId/save-all",
    async (request, reply) => {
      const context = await repository.getCodeTabExecutionContext(
        applicationOwnerId(),
        request.params.codeTabId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Code tab not found." });
      }
      const sessions =
        (await repository.listCodeSessions(
          applicationOwnerId(),
          request.params.codeTabId,
        )) ?? [];
      const session = sessions.find((candidate) =>
        ["starting", "running", "idle"].includes(candidate.status),
      );
      if (!session) {
        return reply.code(409).send({ error: "Code editor is not running." });
      }
      if (!runtime.isWorkerConnected(context.workerId)) {
        return reply.code(503).send({ error: "Worker is offline." });
      }
      try {
        return reply.send(
          codeSaveAllResultSchema.parse(
            await runtime.saveAll(context.workerId, session.id),
          ),
        );
      } catch (error) {
        return reply.code(502).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { codeTabId: string } }>(
    "/api/code-tabs/:codeTabId/stop",
    async (request, reply) => {
      const context = await repository.getCodeTabExecutionContext(
        applicationOwnerId(),
        request.params.codeTabId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Code tab not found." });
      }
      const sessions =
        (await repository.listCodeSessions(
          applicationOwnerId(),
          request.params.codeTabId,
        )) ?? [];
      const session = sessions.find(
        (candidate) => candidate.status !== "stopped",
      );
      if (!session) return reply.code(204).send();
      if (!runtime.isWorkerConnected(context.workerId)) {
        return reply.code(503).send({ error: "Worker is offline." });
      }
      try {
        const status = codeRuntimeStatusSchema.parse(
          await runtime.stop(context.workerId, session.id),
        );
        await runtime.revokeTunnelSession(session.id);
        await runtime.revokeDirectSession(applicationOwnerId(), session.id);
        await runtime.recordSessionRuntime(
          applicationOwnerId(),
          context.codeTab.id,
          session.id,
          status,
        );
        return reply.send(status);
      } catch (error) {
        return reply.code(502).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { codeTabId: string } }>(
    "/api/code-tabs/:codeTabId/theme",
    async (request, reply) => {
      const input = codeThemeUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getCodeTabExecutionContext(
        applicationOwnerId(),
        request.params.codeTabId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Code tab not found." });
      }
      const codeTab = await repository.updateCodeTab(
        applicationOwnerId(),
        request.params.codeTabId,
        { themeMode: "follow-cantrip" },
      );
      const sessions =
        (await repository.listCodeSessions(
          applicationOwnerId(),
          request.params.codeTabId,
        )) ?? [];
      const session = sessions.find((candidate) =>
        ["starting", "running", "idle"].includes(candidate.status),
      );
      if (session && runtime.isWorkerConnected(context.workerId)) {
        try {
          const status = codeRuntimeStatusSchema.parse(
            await runtime.setTheme(
              context.workerId,
              session.id,
              input.data.appearance,
            ),
          );
          await runtime.recordSessionRuntime(
            applicationOwnerId(),
            context.codeTab.id,
            session.id,
            status,
          );
        } catch (error) {
          return reply.code(502).send({ error: errorMessage(error) });
        }
      }
      return reply.send(codeTabWireSummarySchema.parse(codeTab));
    },
  );
}
