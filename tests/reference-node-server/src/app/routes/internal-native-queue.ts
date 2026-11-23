import {
  managedQueueLookupSchema,
  managedQueueImportSchema,
  managedQueueImportAckSchema,
  managedQueueReadSchema,
  managedQueueMutateSchema,
  managedQueueStartReceiptSchema,
  managedQueueStartReceiptResultSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../../config.js";
import type { ServerRepository } from "../../db/repository.js";
import { NativeCommandError } from "../../db/repository/native-commands.js";
import { authenticateWorkerRequest } from "../../workers/credentials.js";
import type { ApplicationOwnerContext } from "../http/owner-context.js";
import {
  waitForManagedQueueReceipt,
  notifyManagedQueueReceipt,
} from "../runtime/managed-queue-receipts.js";
export function installInternalNativeQueueRoutes(
  app: FastifyInstance,
  dependencies: {
    config: ServerConfig;
    repository: ServerRepository;
    runAsOwner: ApplicationOwnerContext["runAsOwner"];
    dispatchNextQueuedPrompt: (chatId: string) => Promise<void>;
    publishChatInvalidation: (chatId: string, resource: "chat-queue") => void;
  },
) {
  const { repository, config, runAsOwner } = dependencies;
  for (const action of [
    "lookup",
    "read",
    "mutate",
    "start-receipt",
    "import",
    "import-ack",
  ] as const)
    app.post(
      `/api/internal/native-queue/${action}`,
      { logLevel: "warn" },
      async (request, reply) => {
        const parsed = (
          action === "lookup"
            ? managedQueueLookupSchema
            : action === "read"
              ? managedQueueReadSchema
              : action === "mutate"
                ? managedQueueMutateSchema
                : action === "import"
                  ? managedQueueImportSchema
                  : action === "import-ack"
                    ? managedQueueImportAckSchema
                    : managedQueueStartReceiptSchema
        ).safeParse(request.body);
        if (!parsed.success)
          return reply.code(400).send({ code: "invalid-queue-request" });
        const workerId =
          "admission" in parsed.data
            ? parsed.data.admission.workerId
            : parsed.data.workerId;
        const authentication = await authenticateWorkerRequest(
          repository,
          config,
          request,
          workerId,
          "worker:agent-tools",
        );
        if (!authentication)
          return reply.code(401).send({ code: "unauthorized" });
        return runAsOwner(authentication.ownerId, async () => {
          try {
            if (action === "lookup")
              return repository.managedQueue.lookup(
                authentication.ownerId,
                managedQueueLookupSchema.parse(parsed.data).admission,
              );
            if (action === "read") {
              const input = managedQueueReadSchema.parse(parsed.data);
              return repository.managedQueue.read(
                authentication.ownerId,
                workerId,
                input.session,
              );
            }
            if (action === "import")
              return repository.managedQueue.importNative(
                authentication.ownerId,
                managedQueueImportSchema.parse(parsed.data),
              );
            if (action === "import-ack") {
              const input = managedQueueImportAckSchema.parse(parsed.data);
              const result = await repository.managedQueue.acknowledgeImport(
                authentication.ownerId,
                input,
              );
              dependencies.publishChatInvalidation(
                input.session.chatId,
                "chat-queue",
              );
              if (input.receipt.deleted && !input.receipt.conflict)
                void dependencies.dispatchNextQueuedPrompt(
                  input.session.chatId,
                );
              return result;
            }
            if (action === "mutate") {
              const input = managedQueueMutateSchema.parse(parsed.data);
              const result = await repository.managedQueue.mutate(
                authentication.ownerId,
                input,
              );
              dependencies.publishChatInvalidation(
                input.admission.session.chatId,
                "chat-queue",
              );
              notifyManagedQueueReceipt(input.admission.session.chatId);
              if (
                result.receipt.status === "applied" &&
                ["add", "update", "start"].includes(input.mutation.kind)
              )
                void dependencies.dispatchNextQueuedPrompt(
                  input.admission.session.chatId,
                );
              return result;
            }
            const input = managedQueueStartReceiptSchema.parse(parsed.data);
            const controller = new AbortController();
            const aborted = () =>
              controller.abort(
                new Error("The queue receipt view disconnected."),
              );
            request.raw.on("aborted", aborted);
            reply.raw.on("close", aborted);
            const timer = setTimeout(
              () =>
                controller.abort(
                  new Error("The queued action is still pending."),
                ),
              90_000,
            );
            try {
              return managedQueueStartReceiptResultSchema.parse(
                await waitForManagedQueueReceipt(
                  repository,
                  authentication.ownerId,
                  workerId,
                  input.session,
                  input.claimId,
                  controller.signal,
                ),
              );
            } finally {
              clearTimeout(timer);
              request.raw.off("aborted", aborted);
              reply.raw.off("close", aborted);
            }
          } catch (error) {
            if (error instanceof NativeCommandError)
              return reply.code(error.statusCode).send({ code: error.code });
            if (action === "start-receipt")
              return reply.code(409).send({ code: "queue-receipt-pending" });
            throw error;
          }
        });
      },
    );
}
