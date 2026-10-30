import type { ConversationUsage } from "@cantrip/protocol";
import { recordConversationUsage } from "@/lib/api/conversations";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
  type ClientSessionIdentitySnapshot,
} from "@/lib/client-session";

/** One renderer's deliberate interactions, with no durable offline event backlog. */
export class ConversationUsageTracker {
  private sequence = 0;
  private latest: ConversationUsage | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private coalescedChat: string | null = null;
  private disposed = false;
  constructor(
    private readonly send: (
      chatId: string,
      input: ConversationUsage,
    ) => Promise<unknown>,
    private readonly current: () => boolean,
    private readonly clientId = crypto.randomUUID(),
  ) {}
  record(chatId: string, kind: "selection" | "interaction" = "selection") {
    if (this.disposed || !this.current()) return;
    // A row click and its focus event belong to one activation. Later clicks
    // still count, even if the user selects the already-visible conversation.
    if (kind === "selection" && this.coalescedChat === chatId) return;
    this.coalescedChat = chatId;
    queueMicrotask(() => {
      this.coalescedChat = null;
    });
    clearTimeout(this.timer);
    const operation = {
      clientId: this.clientId,
      operationId: crypto.randomUUID(),
      sequence: ++this.sequence,
    };
    this.latest = operation;
    void this.attempt(chatId, operation, 0);
  }
  private async attempt(
    chatId: string,
    operation: ConversationUsage,
    retry: number,
  ) {
    if (this.disposed || !this.current() || this.latest !== operation) return;
    try {
      await this.send(chatId, operation);
    } catch {
      // Recency is independent of opening/sending. Keep only the latest
      // interaction and replay its original receipt, never old offline focus.
      if (
        retry < 2 &&
        !this.disposed &&
        this.current() &&
        this.latest === operation
      )
        this.timer = setTimeout(
          () => {
            void this.attempt(chatId, operation, retry + 1);
          },
          retry === 0 ? 500 : 2000,
        );
    }
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.latest = null;
  }
}
let active:
  | {
      identity: ClientSessionIdentitySnapshot;
      tracker: ConversationUsageTracker;
    }
  | undefined;
export function noteConversationUsage(
  chatId: string,
  kind: "selection" | "interaction" = "selection",
) {
  const identity = getClientSessionIdentitySnapshot();
  if (active && !clientSessionIdentityMatches(active.identity)) {
    active.tracker.dispose();
    active = undefined;
  }
  if (!identity) return;
  active ??= {
    identity,
    tracker: new ConversationUsageTracker(
      (id, operation) => recordConversationUsage(id, operation, identity),
      () => clientSessionIdentityMatches(identity),
    ),
  };
  active.tracker.record(chatId, kind);
}
