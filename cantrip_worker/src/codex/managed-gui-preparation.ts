import type { NativeCommandReceipt } from "@cantrip/protocol";

type LogicalRoot = Pick<
  NativeCommandReceipt,
  "operationId" | "operationGeneration"
>;

/** Exact command cancellation can arrive before asynchronous GUI preparation begins. */
export class ManagedGuiPreparationRegistry {
  private readonly controllers = new Map<string, AbortController>();

  private key(chatId: string, root: LogicalRoot): string {
    return JSON.stringify([chatId, root.operationId, root.operationGeneration]);
  }

  private controller(chatId: string, root: LogicalRoot): AbortController {
    const key = this.key(chatId, root);
    let controller = this.controllers.get(key);
    if (!controller) {
      controller = new AbortController();
      this.controllers.set(key, controller);
    }
    return controller;
  }

  signal(chatId: string, root: LogicalRoot): AbortSignal {
    return this.controller(chatId, root).signal;
  }

  cancel(chatId: string, root: LogicalRoot): void {
    this.controller(chatId, root).abort(
      new Error("The GUI request was stopped before native dispatch."),
    );
  }

  complete(chatId: string, root: LogicalRoot): void {
    this.controllers.delete(this.key(chatId, root));
  }

  disconnect(): void {
    for (const controller of this.controllers.values())
      controller.abort(new Error("The managed worker connection was lost."));
    this.controllers.clear();
  }
}
