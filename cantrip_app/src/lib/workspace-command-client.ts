import {
  applyWorkspaceCommand,
  workspaceActionSchema,
  workspaceOwnershipSchema,
  type WorkspaceAction,
  type WorkspaceCommand,
  type WorkspaceOwnership,
  workspaceReceiptSchema,
  type WorkspaceReceipt,
} from "@cantrip/protocol";
export {
  workspaceReceiptSchema,
  type WorkspaceReceipt,
} from "@cantrip/protocol";
export interface WorkspaceTransport {
  read(): Promise<WorkspaceOwnership>;
  execute(command: WorkspaceCommand): Promise<WorkspaceReceipt>;
  classify(error: unknown): "conflict" | "rejected" | "uncertain";
}
type Pending = {
  id: string;
  action: WorkspaceAction;
  sent?: WorkspaceCommand;
  resolve: (receipt: WorkspaceReceipt) => void;
  reject: (error: unknown) => void;
};
export interface WorkspaceClientState {
  authoritative: WorkspaceOwnership;
  projected: WorkspaceOwnership;
  pendingCount: number;
  error: unknown | null;
}

/** One session/window-bound queue. Sent bytes remain immutable until a receipt
 * or an explicit rejection proves their outcome. Never restore old snapshots. */
export class WorkspaceCommandClient {
  private base: WorkspaceOwnership;
  private queue: Pending[] = [];
  private running = false;
  private disposed = false;
  private error: unknown | null = null;
  private listeners = new Set<() => void>();
  private state: WorkspaceClientState;

  constructor(
    initial: WorkspaceOwnership,
    private readonly windowId: string,
    private readonly generation: number,
    private readonly transport: WorkspaceTransport,
    private readonly allocateId: () => string = () => crypto.randomUUID(),
  ) {
    this.base = workspaceOwnershipSchema.parse(initial);
    this.assertAttachment();
    this.state = {
      authoritative: this.base,
      projected: this.base,
      pendingCount: 0,
      error: null,
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private assertAttachment() {
    if (
      this.base.windows.find((w) => w.id === this.windowId)
        ?.attachmentGeneration !== this.generation
    )
      throw new Error("Workspace window attachment changed.");
  }
  private command(pending: Pending, revision: number): WorkspaceCommand {
    return {
      operationId: pending.id,
      projectId: this.base.projectId,
      workspaceId: this.base.id,
      windowId: this.windowId,
      attachmentGeneration: this.generation,
      expectedRevision: revision,
      action: pending.action,
    };
  }
  private publish() {
    let projected = this.base;
    for (const pending of this.queue) {
      // A newer observation may already include this sent operation. Until its
      // receipt arrives, avoid applying it twice to a newer observed snapshot.
      if (pending.sent && this.base.revision > pending.sent.expectedRevision)
        continue;
      try {
        projected = applyWorkspaceCommand(
          projected,
          this.command(pending, projected.revision),
        ).layout;
      } catch {
        /* Keep queued intent; validate it against actual state before sending. */
      }
    }
    this.state = {
      authoritative: this.base,
      projected,
      pendingCount: this.queue.length,
      error: this.error,
    };
    for (const listener of this.listeners) listener();
  }
  private accept(value: WorkspaceOwnership) {
    const layout = workspaceOwnershipSchema.parse(value);
    if (
      layout.id !== this.base.id ||
      layout.projectId !== this.base.projectId ||
      layout.mainWindowId !== this.base.mainWindowId
    )
      throw new Error("Workspace response scope changed.");
    if (layout.revision > this.base.revision) this.base = layout;
    this.assertAttachment();
  }
  observe(layout: WorkspaceOwnership) {
    if (this.disposed) return;
    try {
      this.accept(layout);
      this.publish();
    } catch (error) {
      this.dispose(error);
    }
  }
  dispatch(action: WorkspaceAction): Promise<WorkspaceReceipt> {
    if (this.disposed)
      return Promise.reject(new Error("Workspace controller is disposed."));
    const parsed = workspaceActionSchema.parse(action);
    return new Promise((resolve, reject) => {
      const pending = {
        id: this.allocateId(),
        action: parsed,
        resolve,
        reject,
      };
      this.queue.push(pending);
      this.publish();
      if (!this.error) void this.pump();
    });
  }
  /** Explicit transport recovery retries the same sent command, not a rebase. */
  retry() {
    if (!this.disposed) {
      this.error = null;
      this.publish();
      void this.pump();
    }
  }
  dispose(reason: unknown = new Error("Workspace controller was disposed.")) {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.queue) pending.reject(reason);
    this.queue = [];
    this.error = reason;
    this.publish();
    this.listeners.clear();
  }
  private async pump() {
    if (this.running || this.disposed) return;
    this.running = true;
    let conflicts = 0;
    try {
      while (this.queue.length && !this.disposed && !this.error) {
        const pending = this.queue[0]!;
        if (!pending.sent) {
          try {
            this.assertAttachment();
            const command = this.command(pending, this.base.revision);
            applyWorkspaceCommand(this.base, command);
            pending.sent = command;
          } catch (error) {
            this.queue.shift();
            pending.reject(error);
            this.publish();
            continue;
          }
        }
        let receipt: WorkspaceReceipt;
        try {
          receipt = workspaceReceiptSchema.parse(
            await this.transport.execute(structuredClone(pending.sent)),
          );
          if (this.disposed) return;
          if (
            receipt.operationId !== pending.id ||
            receipt.appliedRevision !== pending.sent.expectedRevision + 1
          )
            throw new Error(
              "Workspace receipt does not acknowledge the sent command.",
            );
          this.accept(receipt.layout);
          if (receipt.layout.revision < this.base.revision) {
            receipt = {
              ...receipt,
              layout: this.base,
              focusWindowId: null,
              emptyWindowIds: [],
            };
          }
        } catch (error) {
          if (this.disposed) return;
          const kind = this.transport.classify(error);
          if (kind === "conflict") {
            // The server explicitly rejected this revision, so rebasing is safe.
            pending.sent = undefined;
            try {
              const latest = await this.transport.read();
              if (this.disposed) return;
              this.accept(latest);
            } catch (readError) {
              this.error = readError;
              this.publish();
              break;
            }
            if (++conflicts >= 3) {
              this.error = error;
              this.publish();
              break;
            }
            this.publish();
            continue;
          }
          if (kind === "rejected") {
            this.queue.shift();
            pending.reject(error);
            this.publish();
            continue;
          }
          // Unknown outcome: retain sent bytes and block later operations until recovered.
          this.error = error;
          this.publish();
          break;
        }
        this.queue.shift();
        conflicts = 0;
        pending.resolve(receipt);
        this.publish();
      }
    } finally {
      this.running = false;
      if (this.queue.length && !this.disposed && !this.error) void this.pump();
    }
  }
}
