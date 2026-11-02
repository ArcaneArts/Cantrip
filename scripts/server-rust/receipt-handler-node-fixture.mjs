// Execute the unchanged receipt route against the real migrated repository.
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const Fastify = require("fastify");
import { installInternalNativeCommandRoutes } from "../../cantrip_server/src/app/routes/internal-native-commands.ts";
import { readServerConfig } from "../../cantrip_server/src/config.ts";
export async function receiptHandlerFixture(repository, input) {
  const app = Fastify(),
    trace = [];
  let currentOwner, dispatchWork;
  const config = readServerConfig();
  const previousWarn = app.log.warn;
  app.log.warn = (context, message) =>
    trace.push({ type: "warning", context, message });
  installInternalNativeCommandRoutes(app, {
    repository,
    config,
    serverId: "receipt-fixture-server",
    runAsOwner: (owner, run) => {
      currentOwner = owner;
      return run();
    },
    live: {
      publishChatInvalidation: (chatId, resource) =>
        trace.push({
          type: "invalidation",
          ownerId: currentOwner,
          chatId,
          resource,
        }),
      publishChatTurnBoundary: (chatId, projectId, context) =>
        trace.push({
          type: "boundary",
          ownerId: currentOwner,
          chatId,
          projectId,
          context,
        }),
      publishChatSummary() {},
      publishEncryptedChatMessage() {},
      publishTaskMessage() {},
    },
    dispatchNextQueuedPrompt: (chatId) => {
      const owner = currentOwner;
      dispatchWork = (async () => {
        const receipt = await repository.nativeCommands.lookup(
          owner,
          input.input.workerId,
          input.input.operationId,
        );
        trace.push({
          type: "dispatch",
          ownerId: owner,
          chatId,
          committedStatus: receipt?.status ?? null,
        });
        if (input.dispatchError)
          throw new Error("Controlled queue dispatch failure");
      })();
      return dispatchWork;
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal/native-commands/receipt",
      headers: { authorization: `Bearer ${config.workerToken}` },
      payload: input.input,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await dispatchWork?.catch(() => {});
    return { status: response.statusCode, body: response.json(), trace };
  } finally {
    try {
      await app.close();
    } finally {
      app.log.warn = previousWarn;
    }
  }
}
