import type { TerminalHydrationMetadata } from "@cantrip/protocol";

export interface TerminalHydrationTarget {
  reset(): void;
}

export class TerminalHydrationController {
  #remainingChunks = 0;

  begin(
    metadata: TerminalHydrationMetadata,
    target: TerminalHydrationTarget,
  ): void {
    if (this.#remainingChunks !== 0) {
      throw new Error("Terminal hydration frames overlapped.");
    }
    this.#remainingChunks = metadata.snapshotChunks;
    if (metadata.format === "canonical-xterm") target.reset();
  }

  consumedOutput(): void {
    if (this.#remainingChunks > 0) this.#remainingChunks -= 1;
  }

  assertReady(): void {
    if (this.#remainingChunks !== 0) {
      throw new Error("The terminal snapshot was incomplete.");
    }
  }
}
