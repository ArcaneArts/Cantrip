import {
  mutateManagedGuiQueue,
  lookupManagedGuiQueue,
} from "../../cantrip_server/src/app/runtime/managed-queue-input.ts";
export async function managedQueueFixture(repository, input) {
  const { owner, chat, worker, session, claimId: id, content } = input,
    queue = repository.managedQueue;
  if (["gui-context", "gui-mutate", "gui-lookup"].includes(input.action)) {
    const context =
      input.context ?? (await repository.getChatExecutionContext(owner, chat));
    if (!context) throw new Error("GUI queue context is unavailable.");
    if (input.action === "gui-context") return context;
    return (
      input.action === "gui-mutate"
        ? mutateManagedGuiQueue
        : lookupManagedGuiQueue
    )(repository, owner, context, content, input.options ?? {});
  }
  switch (input.action) {
    case "snapshot":
      return queue.snapshot(owner, chat);
    case "read":
      return queue.read(owner, worker, session);
    case "mutate":
      return queue.mutate(owner, content, input.options ?? {});
    case "lookup":
      return queue.lookup(owner, content);
    case "gui-operation":
      return queue.guiOperation(owner, chat, input.operation);
    case "claim-item":
      return queue.claimItem(owner, chat, input.prompt, input.revision, id);
    case "claim-next":
      return queue.claimNext(owner, chat);
    case "claim":
      return queue.claim(owner, chat, id);
    case "release":
      return queue.releaseUnadmitted(owner, chat, id);
    case "start-receipt":
      return queue.startReceipt(owner, worker, session, id);
    case "import":
      return queue.importNative(owner, content);
    case "ack-import":
      return queue.acknowledgeImport(owner, content);
    case "pending-dispatches":
      return queue.pendingDispatches();
    case "pending-notifications":
      return queue.pendingNotifications(input.limit);
    case "ack-notification":
      await queue.acknowledgeNotification(chat, input.revision);
      return null;
    case "defer-notification":
      await queue.deferNotification(chat);
      return null;
    default:
      throw new Error("Unknown managed queue fixture action");
  }
}
