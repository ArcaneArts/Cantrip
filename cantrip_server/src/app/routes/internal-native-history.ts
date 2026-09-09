import {
  nativeHistoryBindingOpenSchema,
  nativeHistoryResolveSchema,
  nativeHistoryIngestSchema,
  nativeHistoryArchiveReadSchema,
  nativeHistoryTurnArchiveReadSchema,
  nativeHistoryBatchArchiveReadSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../../config.js";
import type { ServerRepository } from "../../db/repository.js";
import { NativeHistoryError } from "../../db/repository/native-history-bindings.js";
import { NativeHistoryBatchRejectionError } from "../../db/repository/native-history-rejections.js";
import { authenticateWorkerRequest } from "../../workers/credentials.js";
import type { ApplicationOwnerContext } from "../http/owner-context.js";

export function installInternalNativeHistoryRoutes(
  app: FastifyInstance,
  dependencies: {
    config: ServerConfig;
    repository: Pick<
      ServerRepository,
      | "nativeHistoryBindings"
      | "nativeHistoryItems"
      | "nativeHistoryIngestion"
      | "nativeHistoryArchive"
      | "authenticateWorkerCredential"
    >;
    runAsOwner: ApplicationOwnerContext["runAsOwner"];
  },
): void {
  const { config, repository, runAsOwner } = dependencies;
  function install<T extends { workerId: string }>(
    action: string,
    schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: T } | { success: false };
    },
    invalidCode: string,
    execute: (ownerId: string, input: T) => Promise<unknown>,
  ) {
    app.post(
      `/api/internal/native-history/${action}`,
      { logLevel: "warn" },
      async (request, reply) => {
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ code: invalidCode });
        const authentication = await authenticateWorkerRequest(
          repository,
          config,
          request,
          parsed.data.workerId,
          "worker:agent-tools",
        );
        if (!authentication)
          return reply.code(401).send({ code: "unauthorized" });
        return runAsOwner(authentication.ownerId, async () => {
          try {
            return await execute(authentication.ownerId, parsed.data);
          } catch (error) {
            if (error instanceof NativeHistoryBatchRejectionError)
              return reply
                .code(409)
                .send({ code: error.code, rejection: error.rejection });
            if (error instanceof NativeHistoryError)
              return reply.code(error.statusCode).send({ code: error.code });
            throw error;
          }
        });
      },
    );
  }
  install(
    "open",
    nativeHistoryBindingOpenSchema,
    "invalid-native-history-binding",
    async (ownerId, input) => ({
      binding: await repository.nativeHistoryBindings.open(ownerId, input),
    }),
  );
  install(
    "resolve",
    nativeHistoryResolveSchema,
    "invalid-native-history-resolution",
    async (ownerId, input) => ({
      items: await repository.nativeHistoryItems.resolve(ownerId, input),
    }),
  );
  install(
    "archive",
    nativeHistoryArchiveReadSchema,
    "invalid-native-history-archive",
    (ownerId, input) => repository.nativeHistoryArchive.read(ownerId, input),
  );
  // The repository owns canonical writes, checkpoint and publication in one
  // transaction. A disconnected caller may retry the same immutable batch;
  // neither this route nor publication dispatches native input.
  install(
    "archive-turns",
    nativeHistoryTurnArchiveReadSchema,
    "invalid-native-history-turn-archive",
    (ownerId, input) =>
      repository.nativeHistoryArchive.readTurns(ownerId, input),
  );
  install(
    "archive-batches",
    nativeHistoryBatchArchiveReadSchema,
    "invalid-native-history-batch-archive",
    (ownerId, input) =>
      repository.nativeHistoryArchive.readBatches(ownerId, input),
  );
  install(
    "ingest",
    nativeHistoryIngestSchema,
    "invalid-native-history-batch",
    (ownerId, input) =>
      repository.nativeHistoryIngestion.ingest(ownerId, input),
  );
}
