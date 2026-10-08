import type { TerminalServerMessage, TerminalSummary } from "@cantrip/protocol";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  links: [] as Array<{
    onClose(): void;
    onMessage(message: TerminalServerMessage): Promise<void>;
    operationId: string;
    close: ReturnType<typeof vi.fn>;
  }>,
  renderers: [] as Array<{ text: string; disposed: boolean }>,
  writes: [] as Array<() => void>,
  holdWrites: false,
  openOutput: vi.fn(),
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    element = null;
    text = "";
    disposed = false;
    constructor() {
      fixture.renderers.push(this);
    }
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} };
    }
    focus() {}
    refresh() {}
    dispose() {
      this.disposed = true;
    }
    write(text: string, callback?: () => void) {
      const complete = () => {
        this.text += text;
        callback?.();
      };
      if (fixture.holdWrites) fixture.writes.push(complete);
      else complete();
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@/lib/api", () => ({
  getWorkers: async () => [{ workerId: "worker" }],
}));
vi.mock("@/lib/client-log-relay", () => ({
  clientLogger: { info() {}, debug() {}, warn() {}, rateLimited() {} },
  operationalErrorMetadata: () => ({}),
}));
vi.mock("@/lib/surface-private-state-worker-encryption", () => ({
  ensureSurfacePrivateStateWorkerEncryption: async () => {},
}));
vi.mock("@/lib/surface-stream-encryption", () => ({
  openSurfaceStreamContent: fixture.openOutput,
  protectSurfaceStreamContent: async () => ({}),
}));
vi.mock("@/lib/terminal-worker-link", () => ({
  openTerminalWorkerLink: async (
    input: Omit<(typeof fixture.links)[number], "close">,
  ) => {
    const link = { ...input, close: vi.fn(() => input.onClose()) };
    fixture.links.push(link);
    return { ...link, route: "relay", activate() {}, send: () => true };
  },
}));
vi.mock("./terminal-link-layer", () => ({
  installTerminalLinkLayer: () => ({ dispose() {}, refresh() {} }),
}));
vi.mock("./use-mobile-terminal-keyboard", () => ({
  useMobileTerminalKeyboard: () => ({ open: false, contentInset: 0 }),
}));
vi.mock("@/components/ui/surface-loading-veil", () => ({
  SurfaceLoadingVeil: () => null,
}));
import { TerminalView } from "./terminal-view";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const terminal: TerminalSummary = {
  id: "terminal",
  projectId: "project",
  kind: "interactive",
  title: "Terminal",
  position: 0,
  status: "running",
  activeWorkerId: "worker",
  worktreeId: "folder-root:project",
  linkedChatId: null,
  runConfigurationId: null,
  runConfigurationRuntimeId: null,
  directoryPath: null,
  service: { enabled: false, command: "" },
  createdAt: "2026-10-08T12:00:00.000Z",
  updatedAt: "2026-10-08T12:00:00.000Z",
};
let renderer: TestRenderer.ReactTestRenderer | undefined;
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
async function mount(onExit?: () => void, ready = true) {
  await act(async () => {
    renderer = TestRenderer.create(
      <TerminalView terminal={terminal} onExit={onExit} />,
      {
        createNodeMock: () => ({
          clientWidth: 800,
          clientHeight: 600,
          addEventListener() {},
          removeEventListener() {},
          contains: () => false,
        }),
      },
    );
    await settle();
  });
  if (ready)
    await act(async () => {
      await fixture.links[0]!.onMessage({
        type: "ready",
      } as TerminalServerMessage);
    });
}
async function exit(exitCode: number) {
  await act(async () => {
    await fixture.links[0]!.onMessage({ type: "exit", exitCode, signal: null });
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  fixture.links.length = fixture.renderers.length = fixture.writes.length = 0;
  fixture.holdWrites = false;
  fixture.openOutput
    .mockReset()
    .mockResolvedValue({ type: "terminal.output", data: "final output" });
  vi.stubGlobal("document", {
    documentElement: { classList: { contains: () => false } },
  });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: () => "#000000",
  }));
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("Terminal process exit", () => {
  it.each([0, 7])(
    "retains ordinary exit %i beyond reconnect backoff",
    async (exitCode) => {
      await mount();
      await exit(exitCode);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(fixture.links).toHaveLength(1);
      expect(fixture.renderers[0]!.disposed).toBe(false);
      expect(fixture.renderers[0]!.text).toContain(
        `[Process exited ${exitCode}]`,
      );
      expect(
        renderer!.root.findByProps({ role: "status" }).children.join(""),
      ).toContain(`${exitCode}`);
    },
  );
  it.each([false, true])(
    "drains protected output and writes before close (linked=%s)",
    async (linked) => {
      const onExit = linked ? vi.fn() : undefined;
      await mount(onExit);
      fixture.holdWrites = true;
      const link = fixture.links[0]!;
      let release!: (value: { type: string; data: string }) => void;
      fixture.openOutput.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      let completion!: Promise<void>;
      await act(async () => {
        void link.onMessage({
          type: "output",
          operationId: link.operationId,
          sequence: 0,
          protectedData: {},
        } as TerminalServerMessage);
        await settle();
        completion = link.onMessage({
          type: "exit",
          exitCode: 7,
          signal: null,
        });
        await settle();
      });
      expect(link.close).not.toHaveBeenCalled();
      if (onExit) expect(onExit).not.toHaveBeenCalled();
      await act(async () => {
        release({ type: "terminal.output", data: "FINAL OUTPUT" });
        await settle();
      });
      expect(link.close).not.toHaveBeenCalled();
      await act(async () => {
        fixture.holdWrites = false;
        fixture.writes.shift()!();
        await completion;
      });
      expect(fixture.renderers[0]!.text).toContain("FINAL OUTPUT");
      expect(link.close).toHaveBeenCalledWith("normal");
      if (linked) expect(onExit).toHaveBeenCalledTimes(1);
      else
        expect(fixture.renderers[0]!.text).toMatch(
          /FINAL OUTPUT[\s\S]*Process exited 7/,
        );
    },
  );
  it("still reconnects an interrupted live process", async () => {
    await mount();
    await act(async () => {
      fixture.links[0]!.onClose();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fixture.links).toHaveLength(2);
    expect(fixture.renderers[0]!.disposed).toBe(true);
  });
  it("cancels an already scheduled reconnect when a process exit arrives", async () => {
    await mount();
    await act(async () => {
      fixture.links[0]!.onClose();
    });
    await exit(7);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(fixture.links).toHaveLength(1);
  });
  it("shows an exit that arrives before ready without a loading veil", async () => {
    await mount(undefined, false);
    await exit(0);
    expect(
      renderer!.root.findByProps({ role: "status" }).children.join(""),
    ).toContain("0");
    expect(renderer!.root.findAllByProps({ visible: true })).toHaveLength(0);
  });
});
