import { z } from "zod";

const requestSchema = z
  .object({
    kind: z.literal("request"),
    id: z.string(),
    sourceWindowId: z.string(),
    sourceGeneration: z.number().int().nonnegative(),
    viewId: z.string(),
    chatId: z.string(),
  })
  .strict();
const replySchema = z
  .object({
    kind: z.literal("reply"),
    id: z.string(),
    error: z.string().nullable(),
  })
  .strict();
export type ConversationHandoffRequest = z.infer<typeof requestSchema>;
type Port = Pick<
  BroadcastChannel,
  "postMessage" | "addEventListener" | "removeEventListener" | "close"
>;

/** IDs only; protected drafts travel through the existing encrypted handoff.
 * A reply reports completion, never grants ownership or replaces a receipt. */
export function createConversationHandoff(input: {
  serverId: string;
  ownerId: string;
  workspaceId: string;
  windowId: string;
  receive(request: ConversationHandoffRequest): Promise<void>;
  port?: Port;
}) {
  const port =
    input.port ??
    new BroadcastChannel(
      `cantrip-conversation-handoff:${JSON.stringify([input.serverId, input.ownerId, input.workspaceId])}`,
    );
  const pending = new Map<
    string,
    {
      resolve(): void;
      reject(error: unknown): void;
      cleanup(): void;
    }
  >();
  const received = new Map<string, Promise<string | null>>();
  const completed: string[] = [];
  const activeViews = new Map<string, Promise<string | null>>();
  let disposed = false;
  const listener = (event: MessageEvent<unknown>) => {
    if (disposed) return;
    const reply = replySchema.safeParse(event.data);
    if (reply.success) {
      const task = pending.get(reply.data.id);
      if (!task) return;
      task.cleanup();
      pending.delete(reply.data.id);
      if (reply.data.error) task.reject(new Error(reply.data.error));
      else task.resolve();
      return;
    }
    const parsed = requestSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.sourceWindowId !== input.windowId)
      return;
    const request = parsed.data;
    let result = received.get(request.id);
    if (!result) {
      const viewKey = JSON.stringify([
        request.sourceGeneration,
        request.viewId,
        request.chatId,
      ]);
      result =
        activeViews.get(viewKey) ??
        Promise.resolve()
          .then(() => {
            if (disposed)
              throw new Error("Conversation handoff context changed.");
            return input.receive(request);
          })
          .then(
            () => null,
            (error) =>
              error instanceof Error
                ? error.message
                : "Conversation handoff failed.",
          );
      activeViews.set(viewKey, result);
      received.set(request.id, result);
      void result.then(() => {
        if (activeViews.get(viewKey) === result) activeViews.delete(viewKey);
        if (disposed) return;
        completed.push(request.id);
        while (completed.length > 128) received.delete(completed.shift()!);
      });
    }
    void result.then((error) => {
      if (!disposed) {
        try {
          port.postMessage({ kind: "reply", id: request.id, error });
        } catch {
          /* The requester reconciles an unacknowledged outcome. */
        }
      }
    });
  };
  port.addEventListener("message", listener);
  return {
    request(
      request: Omit<ConversationHandoffRequest, "kind" | "id">,
      signal?: AbortSignal,
    ): Promise<void> {
      if (disposed)
        return Promise.reject(
          new Error("Conversation handoff connection closed."),
        );
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.get(id)?.cleanup();
          pending.delete(id);
          reject(
            new Error(
              "Conversation handoff has not been confirmed. Its current owner remains authoritative; retry after reconciliation.",
            ),
          );
        }, 60_000);
        const abort = () => {
          cleanup();
          pending.delete(id);
          reject(
            signal?.reason ?? new Error("Conversation handoff wait canceled."),
          );
        };
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        };
        pending.set(id, { resolve, reject, cleanup });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        try {
          port.postMessage({ ...request, kind: "request", id });
        } catch (error) {
          cleanup();
          pending.delete(id);
          reject(error);
        }
      });
    },
    dispose() {
      disposed = true;
      port.removeEventListener("message", listener);
      port.close();
      for (const task of pending.values()) {
        task.cleanup();
        task.reject(new Error("Conversation handoff context changed."));
      }
      pending.clear();
      received.clear();
      activeViews.clear();
      completed.length = 0;
    },
  };
}
