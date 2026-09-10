import { nativeRuntimeHandoffRequestSchema } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";
import type { ServerRepository } from "../../db/repository.js";
import { NativeCommandError } from "../../db/repository/native-command-errors.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

/** Reserve the route change durably before asking the worker to perform it.
 * Browser disconnection does not cancel the native transfer. A retry resumes the
 * same operation; status reads do not start or mutate native work. */
export function installChatRuntimeHandoffRoutes(
  app: FastifyInstance,
  dependencies: {
    applicationOwnerId(): string;
    repository: Pick<ServerRepository, "nativeRuntimeHandoffs">;
    bridge: Pick<WorkerCommandBus, "request">;
    publishChatInvalidation(chatId: string, resource: "chat"): void;
  },
) {
  const { repository, bridge } = dependencies;
  const active = new Map<string, Promise<void>>();
  const dispatch = (
    ownerId: string,
    state: Awaited<ReturnType<typeof repository.nativeRuntimeHandoffs.begin>>,
    reconnect = false,
  ) => {
    const intent = state.cancelRequested ? "cancel" : "continue";
    const key = `${state.operationId}:${intent}`;
    if (
      ["completed", "cancelled"].includes(state.phase) ||
      (!reconnect && active.has(key))
    )
      return;
    const operation = bridge
      .request(
        state.workerId,
        {
          type: "chat.runtime.handoff",
          chatId: state.chatId,
          operationId: state.operationId,
          intent,
        },
        { ownerId, timeoutMs: null },
      )
      .then(
        () => {},
        async () => {
          await repository.nativeRuntimeHandoffs.failure(
            ownerId,
            state.workerId,
            state.operationId,
            "handoff-worker-unavailable",
          );
        },
      )
      .finally(() => {
        if (active.get(key) === operation) active.delete(key);
        dependencies.publishChatInvalidation(state.chatId, "chat");
      });
    active.set(key, operation);
    // The durable reservation remains the retry authority even if failure
    // diagnostics cannot be stored during a server/database outage.
    void operation.catch(() => {});
  };
  app.post<{ Params: { chatId: string } }>(
    "/api/chats/:chatId/runtime-handoffs",
    async (request, reply) => {
      const input = nativeRuntimeHandoffRequestSchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send({ code: "invalid-native-runtime-handoff" });
      const ownerId = dependencies.applicationOwnerId();
      try {
        const state = await repository.nativeRuntimeHandoffs.begin(
          ownerId,
          request.params.chatId,
          input.data,
        );
        dispatch(ownerId, state);
        dependencies.publishChatInvalidation(state.chatId, "chat");
        return reply.code(202).send(state);
      } catch (error) {
        if (error instanceof NativeCommandError)
          return reply
            .code(error.statusCode)
            .send({ code: error.code, error: error.message });
        throw error;
      }
    },
  );
  app.get<{ Params: { chatId: string; operationId: string } }>(
    "/api/chats/:chatId/runtime-handoffs/:operationId",
    async (request, reply) => {
      const state = await repository.nativeRuntimeHandoffs.get(
        dependencies.applicationOwnerId(),
        request.params.chatId,
        request.params.operationId,
      );
      return state ?? reply.code(404).send({ code: "handoff-not-found" });
    },
  );
  app.post<{ Params: { chatId: string; operationId: string } }>(
    "/api/chats/:chatId/runtime-handoffs/:operationId/retry",
    async (request, reply) => {
      const ownerId = dependencies.applicationOwnerId();
      const state = await repository.nativeRuntimeHandoffs.get(
        ownerId,
        request.params.chatId,
        request.params.operationId,
      );
      if (!state) return reply.code(404).send({ code: "handoff-not-found" });
      dispatch(ownerId, state);
      return reply.code(202).send(state);
    },
  );
  app.post<{ Params: { chatId: string; operationId: string } }>(
    "/api/chats/:chatId/runtime-handoffs/:operationId/cancel",
    async (request, reply) => {
      const ownerId = dependencies.applicationOwnerId();
      try {
        // Reserve cancellation under the same chat lock as commit. A worker
        // disconnect cannot erase it, and a late commit cannot overtake it.
        const state =
          await repository.nativeRuntimeHandoffs.requestCancellation(
            ownerId,
            request.params.chatId,
            request.params.operationId,
          );
        dispatch(ownerId, state);
        dependencies.publishChatInvalidation(state.chatId, "chat");
        return reply.code(202).send(state);
      } catch (error) {
        if (error instanceof NativeCommandError)
          return reply
            .code(error.statusCode)
            .send({ code: error.code, error: error.message });
        throw error;
      }
    },
  );
  return {
    async workerConnected(ownerId: string, workerId: string) {
      // Called after the authenticated socket is command-visible. Read durable
      // reservations rather than guessing from stale readiness or process flags.
      // A prior request may still be settling; it must not suppress recovery on
      // this connection or erase the replacement request when it finally exits.
      const states = await repository.nativeRuntimeHandoffs.activeForWorker(
        ownerId,
        workerId,
      );
      for (const state of states) dispatch(ownerId, state, true);
    },
  };
}
