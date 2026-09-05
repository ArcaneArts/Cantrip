import type {
  CuaApprovalRequestEvent,
  CuaApprovalTerminal,
} from "@cantrip/protocol/computer-use-preview";

export type CuaAgentApprovalEvent =
  CuaApprovalRequestEvent | CuaApprovalTerminal;
export type CuaAgentApprovalPublisher = (
  event: CuaAgentApprovalEvent,
) => Promise<void>;
interface Publication {
  chatId: string;
  emit: CuaAgentApprovalPublisher;
  queue: Promise<void>;
  terminal: boolean;
  finished: boolean;
}

/** Routes native approval lifecycles onto their owning command stream. A Stop
 * arriving while request publication is in flight follows that same request;
 * it never borrows the independent preview command-completion barrier. */
export class CuaAgentApprovalEvents {
  private publications = new Map<string, Publication>();

  publish(
    event: CuaApprovalRequestEvent,
    emit: CuaAgentApprovalPublisher,
  ): Promise<void> {
    const requestKey = event.request.requestKey;
    if (this.publications.has(requestKey) || this.publications.size >= 32)
      return Promise.reject(
        new Error("Computer-use approval publication is unavailable."),
      );
    const publication: Publication = {
      chatId: event.request.provenance.chatId!,
      emit,
      queue: Promise.resolve(),
      terminal: false,
      finished: false,
    };
    this.publications.set(requestKey, publication);
    publication.queue = Promise.resolve().then(() => emit(event));
    // A late publication error is still reported to its caller. Terminal and
    // cleanup scheduling must not create unhandled rejection branches.
    void publication.queue.catch(() => {});
    return publication.queue;
  }

  /** True means this request belongs to an agent stream, including duplicates. */
  terminal(input: Omit<CuaApprovalTerminal, "type">): boolean {
    const publication = this.publications.get(input.requestKey);
    if (!publication || publication.chatId !== input.chatId) return false;
    if (publication.terminal) return true;
    publication.terminal = true;
    publication.queue = publication.queue
      .catch(() => {})
      .then(() =>
        publication.emit({ type: "computer-use.approval.terminal", ...input }),
      );
    void publication.queue.catch(() => {});
    this.cleanup(input.requestKey, publication);
    return true;
  }

  /** Call in authorizeAndWait's finally, after the request key is known. */
  finish(requestKey: string): void {
    const publication = this.publications.get(requestKey);
    if (!publication) return;
    publication.finished = true;
    this.cleanup(requestKey, publication);
  }

  /** Drain before completing the owning worker command. */
  async drain(emit: CuaAgentApprovalPublisher): Promise<void> {
    for (;;) {
      const pending = [...this.publications.values()]
        .filter((publication) => publication.emit === emit)
        .map((publication) => publication.queue);
      if (!pending.length) return;
      await Promise.all(pending);
      const current = [...this.publications.values()].filter(
        (publication) => publication.emit === emit,
      );
      if (current.every((publication) => pending.includes(publication.queue)))
        return;
    }
  }

  private cleanup(requestKey: string, publication: Publication) {
    if (!publication.finished) return;
    const queue = publication.queue;
    void queue
      .catch(() => {})
      .then(() => {
        if (
          this.publications.get(requestKey) === publication &&
          publication.queue === queue
        )
          this.publications.delete(requestKey);
      });
  }
}
