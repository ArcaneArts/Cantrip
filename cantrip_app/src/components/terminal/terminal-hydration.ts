import type { TerminalHydrationMetadata } from "@cantrip/protocol";

export interface TerminalHydrationTarget {
  reset(): void;
}

export function terminalHydrationRecoveryError(
  metadata: TerminalHydrationMetadata,
): string | null {
  if (
    metadata.format !== "legacy-raw" ||
    !metadata.truncated ||
    metadata.recovery === "redraw-requested"
  ) {
    return null;
  }
  return "The saved terminal state was incomplete and its automatic redraw could not be started. Restart the terminal if the display is incomplete.";
}

export class TerminalHydrationController {
  #active: TerminalHydrationMetadata | null = null;
  #lastOutputBoundary: number | null = null;
  #lastProcessGeneration: number | null = null;
  #remainingChunks = 0;

  begin(
    metadata: TerminalHydrationMetadata,
    target: TerminalHydrationTarget,
  ): void {
    if (this.#remainingChunks !== 0) {
      throw new Error("Terminal hydration frames overlapped.");
    }
    if (
      metadata.processGeneration !== undefined &&
      metadata.outputBoundary !== undefined &&
      this.#lastProcessGeneration !== null &&
      this.#lastOutputBoundary !== null &&
      (metadata.processGeneration < this.#lastProcessGeneration ||
        (metadata.processGeneration === this.#lastProcessGeneration &&
          metadata.outputBoundary <= this.#lastOutputBoundary))
    ) {
      throw new Error("A stale terminal snapshot was rejected.");
    }
    this.#active = metadata;
    this.#lastProcessGeneration =
      metadata.processGeneration ?? this.#lastProcessGeneration;
    this.#lastOutputBoundary =
      metadata.outputBoundary ?? this.#lastOutputBoundary;
    this.#remainingChunks = metadata.snapshotChunks;
    if (metadata.format === "canonical-xterm") target.reset();
  }

  consumedOutput(): void {
    if (this.#remainingChunks > 0) this.#remainingChunks -= 1;
  }

  assertReady(): TerminalHydrationMetadata | null {
    if (this.#remainingChunks !== 0) {
      throw new Error("The terminal snapshot was incomplete.");
    }
    const completed = this.#active;
    this.#active = null;
    return completed;
  }
}
