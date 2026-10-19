import type { IPty } from "node-pty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalManager } from "../src/terminal-manager.js";

const native = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node-pty", () => ({ spawn: native.spawn }));

type ExitEvent = Parameters<Parameters<IPty["onExit"]>[0]>[0];

class ControlledPty {
  readonly pid = 12345;
  readonly kill = vi.fn();
  readonly resize = vi.fn();
  readonly write = vi.fn();
  #exit: ((event: ExitEvent) => void) | undefined;

  onData() {
    return { dispose() {} };
  }

  onExit(listener: (event: ExitEvent) => void) {
    this.#exit = listener;
    return { dispose() {} };
  }

  exit(exitCode: number | undefined, signal?: number) {
    // Windows' actual pipe-close event can precede its native exit-code callback,
    // despite node-pty declaring exitCode as always present.
    this.#exit?.({ exitCode, signal } as ExitEvent);
  }
}

const children: ControlledPty[] = [];
const managers: TerminalManager[] = [];

beforeEach(() => {
  native.spawn.mockImplementation(() => {
    const child = new ControlledPty();
    children.push(child);
    return child;
  });
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const child of children) child.exit(0);
  children.length = 0;
  native.spawn.mockReset();
});

describe("terminal native exit events", () => {
  it.each([
    { exitCode: undefined, signal: undefined, expected: -1 },
    { exitCode: undefined, signal: 15, expected: -1 },
    { exitCode: 0, signal: undefined, expected: 0 },
    { exitCode: 7, signal: 2, expected: 7 },
  ])(
    "settles owned shutdown with $exitCode and signal $signal",
    async ({ exitCode, signal, expected }) => {
      const lifecycle = vi.fn();
      const manager = new TerminalManager({ observeLifecycle: lifecycle });
      managers.push(manager);
      const cwd = process.cwd();
      const attached = manager.open(
        "attached",
        "view",
        cwd,
        80,
        24,
        { type: "shell" },
        () => {},
      );
      manager.reconcileServices([
        { terminalId: "service", cwd, command: "controlled-service" },
      ]);
      const service = manager.open(
        "service",
        "service-view",
        cwd,
        80,
        24,
        { type: "shell" },
        () => {},
      );
      expect(children).toHaveLength(2);

      manager.closeAll();
      expect(manager.hasLiveSession("attached")).toBe(true);
      expect(manager.hasLiveSession("service")).toBe(true);
      for (const child of children) {
        expect(child.kill).toHaveBeenCalledOnce();
        expect(() => child.exit(exitCode, signal)).not.toThrow();
      }
      const result = {
        status: "exited",
        exitCode: expected,
        signal: signal ?? null,
      };
      await expect(attached).resolves.toEqual(result);
      await expect(service).resolves.toEqual(result);
      expect(manager.hasLiveSession("attached")).toBe(false);
      expect(manager.hasLiveSession("service")).toBe(false);
      expect(lifecycle.mock.calls.map(([event]) => event)).toEqual([
        { terminalId: "attached", ...result },
        { terminalId: "service", ...result },
      ]);
      // A later native notification cannot rewrite the settled result or double-finalize.
      for (const child of children) child.exit(0);
      expect(lifecycle).toHaveBeenCalledTimes(2);
      expect(native.spawn).toHaveBeenCalledTimes(2);
    },
  );
});
