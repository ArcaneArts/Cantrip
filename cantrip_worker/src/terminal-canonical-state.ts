import { createRequire } from "node:module";

import type { ITerminalAddon } from "@xterm/headless";

const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } =
  require("@xterm/headless") as typeof import("@xterm/headless");
const { SerializeAddon } =
  require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");

export const TERMINAL_CANONICAL_SCROLLBACK_ROWS = 10_000;

export interface TerminalCanonicalSnapshot {
  activeBuffer: "alternate" | "normal";
  cols: number;
  cursor: { x: number; y: number };
  data: string;
  generation: number;
  modes: {
    applicationCursorKeysMode: boolean;
    applicationKeypadMode: boolean;
    bracketedPasteMode: boolean;
    insertMode: boolean;
    mouseTrackingMode: string;
    originMode: boolean;
    reverseWraparoundMode: boolean;
    sendFocusMode: boolean;
    synchronizedOutputMode: boolean;
    wraparoundMode: boolean;
  };
  rows: number;
  scrollbackRows: number;
}

export class TerminalCanonicalState {
  readonly #terminal: InstanceType<typeof HeadlessTerminal>;
  readonly #serializeAddon: InstanceType<typeof SerializeAddon>;
  #generation = 0;
  #disposed = false;

  constructor(cols: number, rows: number) {
    this.#terminal = new HeadlessTerminal({
      allowProposedApi: true,
      cols,
      convertEol: false,
      logLevel: "off",
      rows,
      scrollback: TERMINAL_CANONICAL_SCROLLBACK_ROWS,
    });
    this.#serializeAddon = new SerializeAddon();
    this.#terminal.loadAddon(this.#serializeAddon as unknown as ITerminalAddon);
  }

  get generation(): number {
    return this.#generation;
  }

  write(data: string): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(new Error("Terminal canonical state is disposed."));
    }
    return new Promise((resolve) => this.#terminal.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    if (this.#disposed) return;
    this.#terminal.resize(cols, rows);
  }

  reset(cols: number, rows: number): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#terminal.reset();
    this.#terminal.resize(cols, rows);
  }

  snapshot(): TerminalCanonicalSnapshot {
    if (this.#disposed) {
      throw new Error("Terminal canonical state is disposed.");
    }
    const active = this.#terminal.buffer.active;
    const modes = this.#terminal.modes;
    return {
      activeBuffer: active.type,
      cols: this.#terminal.cols,
      cursor: { x: active.cursorX, y: active.cursorY },
      data: this.#serializeAddon.serialize({
        excludeAltBuffer: false,
        excludeModes: false,
        scrollback: TERMINAL_CANONICAL_SCROLLBACK_ROWS,
      }),
      generation: this.#generation,
      modes: { ...modes },
      rows: this.#terminal.rows,
      scrollbackRows: this.#terminal.buffer.normal.baseY,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#terminal.dispose();
  }
}
