import { randomUUID } from "node:crypto";

import {
  terminalClientMessageSchema,
  terminalOpenResultSchema,
  terminalServerMessageSchema,
  type WorkerCommand,
} from "@cantrip/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { STREAMING_WORKER_COMMAND_TIMEOUT_MS } from "../shared/constants.js";
import type { AccountUsageRecorder } from "../../account-usage/bandwidth-meter.js";
import { recordEncodedFrame } from "../../account-usage/frame-bandwidth.js";
import { principalOwnerId } from "../../auth/principal.js";
import { effectivePermissionProfile } from "../../chats/execution-helpers.js";
import type {
  ChatExecutionContext,
  ModelRuntime,
  ServerRepository,
} from "../../db/repository.js";
import { errorMessage } from "../../http/request-helpers.js";
import { terminalRelayOutputMessage } from "../../terminals/relay.js";
import {
  WorkerUnavailableError,
  type WorkerCommandBus,
} from "../../workers/bridge.js";

export interface TerminalRelaySessionSocket {
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
}

export interface TerminalRelayWebSocketRouteDependencies {
  appOrigins: readonly string[];
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  registerAuthenticatedSocket: (
    socket: TerminalRelaySessionSocket,
    request: FastifyRequest,
  ) => boolean;
  registerSessionSocket: (
    socket: TerminalRelaySessionSocket,
    request: FastifyRequest,
  ) => void;
  repository: Pick<
    ServerRepository,
    | "getChatExecutionContext"
    | "getTerminalExecutionContext"
    | "listEffectiveMcpServers"
  >;
  runtimeForContext: (
    context: ChatExecutionContext,
  ) => Promise<ModelRuntime | null>;
  serverId: string;
  updateTerminalStatus: (
    terminalId: string,
    status: Parameters<ServerRepository["setTerminalStatus"]>[1],
  ) => ReturnType<ServerRepository["setTerminalStatus"]>;
  usageRecorder: AccountUsageRecorder;
}

/** Registers the legacy Terminal WebSocket relay. */
export function installTerminalRelayWebSocketRoute(
  app: FastifyInstance,
  {
    appOrigins,
    bridge,
    registerAuthenticatedSocket,
    registerSessionSocket,
    repository,
    runtimeForContext,
    serverId,
    updateTerminalStatus,
    usageRecorder,
  }: TerminalRelayWebSocketRouteDependencies,
): void {
  app.get<{
    Params: { terminalId: string };
    Querystring: { operationId?: string };
  }>(
    "/api/terminals/:terminalId/connect",
    { websocket: true },
    (socket, request) => {
      if (
        !request.headers.origin ||
        !appOrigins.includes(request.headers.origin)
      ) {
        socket.close(1008, "Origin not allowed");
        return;
      }
      if (!registerAuthenticatedSocket(socket, request)) return;
      registerSessionSocket(socket, request);
      const operationId = request.query.operationId;
      if (!operationId || operationId.length > 200) {
        socket.close(1008, "Terminal stream operation is required");
        return;
      }
      const ownerId = principalOwnerId(request);
      const attachmentId = randomUUID();
      let terminalId: string | null = null;
      let workerId: string | null = null;
      let closed = false;
      let inputQueue = Promise.resolve();
      const send = (message: unknown) => {
        if (socket.readyState === 1) {
          const encoded = JSON.stringify(
            terminalServerMessageSchema.parse(message),
          );
          socket.send(encoded);
          recordEncodedFrame(usageRecorder, {
            ownerId,
            direction: "egress",
            channel: "terminal-relay",
            data: encoded,
          });
        }
      };

      socket.on("close", () => {
        closed = true;
        if (!terminalId || !workerId || !bridge.isConnected(workerId)) return;
        void bridge
          .request(workerId, {
            type: "terminal.detach",
            terminalId,
            attachmentId,
          })
          .catch(() => undefined);
      });

      socket.on("message", (raw) => {
        recordEncodedFrame(usageRecorder, {
          ownerId,
          direction: "ingress",
          channel: "terminal-relay",
          data: raw,
        });
        if (!terminalId || !workerId) return;
        let value: unknown;
        try {
          value = JSON.parse(raw.toString());
        } catch {
          send({ type: "error", message: "Invalid terminal message." });
          return;
        }
        const message = terminalClientMessageSchema.safeParse(value);
        if (!message.success) {
          send({ type: "error", message: "Invalid terminal message." });
          return;
        }
        if (
          message.data.type === "input" &&
          message.data.operationId !== operationId
        ) {
          send({ type: "error", message: "Invalid terminal stream." });
          return;
        }
        const command =
          message.data.type === "input"
            ? {
                type: "terminal.input" as const,
                terminalId,
                serverId,
                operationId,
                sequence: message.data.sequence,
                protectedData: message.data.protectedData,
                complete: false,
              }
            : {
                type: "terminal.resize" as const,
                terminalId,
                cols: message.data.cols,
                rows: message.data.rows,
              };
        if (message.data.type === "input") {
          inputQueue = inputQueue
            .then(async () => {
              await bridge.request(workerId!, command, { timeoutMs: 30_000 });
            })
            .catch((error: unknown) => {
              send({ type: "error", message: errorMessage(error) });
            });
        } else {
          void bridge
            .request(workerId, command, { timeoutMs: 30_000 })
            .catch((error: unknown) => {
              send({ type: "error", message: errorMessage(error) });
            });
        }
      });

      void (async () => {
        const context = await repository.getTerminalExecutionContext(
          ownerId,
          request.params.terminalId,
        );
        if (!context) {
          send({ type: "error", message: "Terminal not found." });
          socket.close(1008, "Terminal not found");
          return;
        }
        if (context.kind === "run-configuration" || !context.stateProtection) {
          send({
            type: "error",
            message:
              "Run configuration terminals are read-only and use the managed runtime output API.",
          });
          socket.close(1008, "Run configuration terminal is read-only");
          return;
        }
        if (closed) return;
        terminalId = context.terminalId;
        workerId = context.workerId;
        if (!bridge.isConnected(workerId)) {
          await updateTerminalStatus(terminalId, "offline");
          send({ type: "error", message: "Project worker is offline." });
          socket.close(1013, "Worker offline");
          return;
        }
        if (closed) {
          await updateTerminalStatus(terminalId, "idle");
          return;
        }
        try {
          let launch: Extract<
            WorkerCommand,
            { type: "terminal.open" }
          >["launch"] = { type: "shell" };
          if (context.linkedChatId) {
            const chat = await repository.getChatExecutionContext(
              ownerId,
              context.linkedChatId,
            );
            const runtime = chat ? await runtimeForContext(chat) : null;
            if (!chat || !runtime) {
              throw new Error(
                "Choose a model for this chat before opening its Codex console.",
              );
            }
            launch = {
              type: "codex",
              threadId: chat.threadId,
              model: runtime.model,
              provider: runtime.provider,
              permissionProfileId: effectivePermissionProfile(chat).effectiveId,
              mcpServers: await repository.listEffectiveMcpServers(
                ownerId,
                chat.projectId,
                workerId,
              ),
            };
          }
          const result = terminalOpenResultSchema.parse(
            await bridge.request(
              workerId,
              {
                type: "terminal.open",
                terminalId,
                attachmentId,
                operationId,
                serverId,
                worktreePath: context.worktreePath,
                stateProtection: context.stateProtection,
                cols: 80,
                rows: 24,
                launch,
              },
              {
                timeoutMs: STREAMING_WORKER_COMMAND_TIMEOUT_MS,
                onEvent: async (event) => {
                  if (event.type === "terminal.ready") {
                    if (closed) {
                      await bridge.request(workerId!, {
                        type: "terminal.detach",
                        terminalId: terminalId!,
                        attachmentId,
                      });
                      return;
                    }
                    await updateTerminalStatus(terminalId!, "running");
                    send({ type: "ready" });
                  } else if (event.type === "terminal.output") {
                    send(terminalRelayOutputMessage(event));
                  }
                },
              },
            ),
          );
          if (result.status === "exited") {
            await updateTerminalStatus(terminalId, "exited");
            if (!closed) send({ type: "exit", ...result });
          }
        } catch (error) {
          await updateTerminalStatus(
            terminalId,
            error instanceof WorkerUnavailableError ? "offline" : "failed",
          );
          if (!closed) send({ type: "error", message: errorMessage(error) });
        }
      })();
    },
  );
}
