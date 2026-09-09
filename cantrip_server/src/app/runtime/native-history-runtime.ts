import type { FastifyInstance } from "fastify";
import type { AppLiveHub } from "../../live/hub.js";
import { installInternalNativeHistoryRoutes } from "../routes/internal-native-history.js";
import { createNativeHistoryPublicationDelivery } from "./native-history-publication-delivery.js";

/** Owns history routes and committed-publication delivery, never native execution. */
export function installNativeHistoryRuntime(
  app: FastifyInstance,
  liveHub: Pick<AppLiveHub, "publishConfirmed">,
  dependencies: Omit<
    Parameters<typeof installInternalNativeHistoryRoutes>[1],
    "repository"
  > & {
    repository: Parameters<
      typeof installInternalNativeHistoryRoutes
    >[1]["repository"] & {
      nativeHistoryPublications: Parameters<
        typeof createNativeHistoryPublicationDelivery
      >[0]["repository"];
    };
  },
) {
  installInternalNativeHistoryRoutes(app, dependencies);
  const delivery = createNativeHistoryPublicationDelivery({
    repository: dependencies.repository.nativeHistoryPublications,
    publish: async (entry) => {
      await liveHub.publishConfirmed({
        ownerId: entry.ownerId,
        scope: { kind: "chat", chatId: entry.chatId },
        resource: "chat-message",
        action: "invalidated",
        entityId: entry.commitId,
        revision: null,
        payload: null,
      });
    },
    onError: (_error, entry) =>
      app.log.warn(
        {
          event: "native-history.publication-pending",
          chatId: entry?.chatId,
          commitId: entry?.commitId,
        },
        "Committed native history publication will retry.",
      ),
  });
  app.addHook("onReady", async () => delivery.start());
  // Stop scheduling before onClose hooks tear down the live hub/database. An
  // in-flight publication that loses shutdown retains its durable pending row.
  app.addHook("preClose", async () => delivery.stop());
  return delivery;
}
