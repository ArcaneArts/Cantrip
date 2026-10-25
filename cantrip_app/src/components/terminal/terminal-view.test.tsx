import type { TerminalServerMessage, TerminalSummary } from "@cantrip/protocol";
import type { ComponentProps } from "react";
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
  protectInput: vi.fn(),
  send: vi.fn(),
  drain: vi.fn(),
  input: null as ((data: string) => boolean) | null,
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    buffer = { active: { type: "normal", viewportY: 0, baseY: 0, length: 24 } };
    getSelectionPosition() {
      return undefined;
    }
    scrollToBottom() {}
    scrollToLine() {}
    clearSelection() {}
    select() {}
    cols = 80;
    rows = 24;
    options = {};
    element = null;
    text = "";
    disposed = false;
    constructor(options: { cols?: number; rows?: number } = {}) {
      this.cols = options.cols ?? 80;
      this.rows = options.rows ?? 24;
      fixture.renderers.push(this);
    }
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData(send: (data: string) => boolean) {
      fixture.input = send;
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
  protectSurfaceStreamContent: fixture.protectInput,
}));
vi.mock("@/lib/terminal-worker-link", () => ({
  openTerminalWorkerLink: async (
    input: Omit<(typeof fixture.links)[number], "close">,
  ) => {
    const link = { ...input, close: vi.fn(() => input.onClose()) };
    fixture.links.push(link);
    return {
      ...link,
      route: "relay",
      activate() {},
      send: fixture.send,
      drain: fixture.drain,
    };
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
import { TerminalView, type TerminalTransferLifecycle } from "./terminal-view";
const transfer = { current: null as TerminalTransferLifecycle | null };

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
async function mount(
  onExit?: () => void,
  ready = true,
  extra: Partial<ComponentProps<typeof TerminalView>> = {},
) {
  await act(async () => {
    renderer = TestRenderer.create(
      <TerminalView
        terminal={terminal}
        onExit={onExit}
        transferLifecycleRef={transfer}
        {...extra}
      />,
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
  transfer.current = null;
  fixture.input = null;
  fixture.send.mockReset().mockReturnValue(true);
  fixture.drain.mockReset().mockResolvedValue(undefined);
  fixture.protectInput.mockReset().mockResolvedValue({});
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
  it("hydrates a passive transfer destination without input or PTY resize, then activates in place", async () => {
    const staging = { onRestored: vi.fn(), onError: vi.fn() };
    const initialViewState = {
      version: 1 as const,
      terminalId: terminal.id,
      workerId: terminal.activeWorkerId,
      buffer: "normal" as const,
      cols: 120,
      rows: 42,
      viewportY: 0,
      followingOutput: true,
      selection: null,
    };
    await mount(undefined, false, {
      transferStaging: staging,
      initialViewState,
    });
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.input!("before ready")).toBe(false);
    expect(staging.onRestored).not.toHaveBeenCalled();
    expect(fixture.renderers[0]).toMatchObject({ cols: 120, rows: 42 });
    await act(async () => {
      await fixture.links[0]!.onMessage({
        type: "ready",
      } as TerminalServerMessage);
    });
    expect(staging.onRestored).toHaveBeenCalledOnce();
    expect(staging.onError).not.toHaveBeenCalled();
    expect(fixture.input!("before commit")).toBe(false);
    expect(fixture.send).not.toHaveBeenCalled();
    await act(async () => {
      renderer!.update(
        <TerminalView
          terminal={terminal}
          transferLifecycleRef={transfer}
          initialViewState={initialViewState}
        />,
      );
    });
    expect(fixture.links).toHaveLength(1);
    expect(fixture.renderers).toHaveLength(1);
    expect(fixture.input!("after commit")).toBe(true);
    await settle();
    expect(
      fixture.send.mock.calls.some(([message]) => message.type === "resize"),
    ).toBe(true);
  });

  it("reports a staged restoration failure without acknowledging readiness or enabling input", async () => {
    const staging = { onRestored: vi.fn(), onError: vi.fn() };
    await mount(undefined, false, {
      transferStaging: staging,
      initialViewState: {
        version: 1,
        terminalId: "wrong",
        workerId: terminal.activeWorkerId,
        buffer: "normal",
        cols: 80,
        viewportY: 0,
        followingOutput: true,
        selection: null,
      },
    });
    await act(async () => {
      await fixture.links[0]!.onMessage({
        type: "ready",
      } as TerminalServerMessage);
    });
    expect(staging.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/another session/),
      }),
    );
    expect(staging.onRestored).not.toHaveBeenCalled();
    expect(fixture.input!("blocked")).toBe(false);
    expect(fixture.send).not.toHaveBeenCalled();
  });
  it.each(["decryption", "sequence"])(
    "refuses transfer after an actual %s output failure",
    async (failure) => {
      await mount();
      const lifecycle = transfer.current!;
      const resume = lifecycle.suspendTransfer();
      const link = fixture.links[0]!;
      if (failure === "decryption")
        fixture.openOutput.mockRejectedValueOnce(
          new Error("output decrypt failed"),
        );
      await act(async () => {
        await link.onMessage({
          type: "output",
          operationId: link.operationId,
          sequence: failure === "sequence" ? 5 : 0,
          protectedData: {},
        } as TerminalServerMessage);
        await link.onMessage({ type: "ready" } as TerminalServerMessage);
      });
      await expect(lifecycle.captureTransfer()).rejects.toThrow(
        failure === "sequence" ? /out of sequence/ : /output decrypt failed/,
      );
      await expect(lifecycle.retireTransfer()).rejects.toThrow(
        failure === "sequence" ? /out of sequence/ : /output decrypt failed/,
      );
      expect(link.close).not.toHaveBeenCalledWith("normal");
      await act(async () => {
        resume();
        await settle();
      });
      expect(fixture.links).toHaveLength(2);
    },
  );

  it("waits for an accepted xterm output write before retiring the renderer", async () => {
    await mount();
    fixture.holdWrites = true;
    const link = fixture.links[0]!;
    const lifecycle = transfer.current!;
    const resume = lifecycle.suspendTransfer();
    await act(async () => {
      void link.onMessage({
        type: "output",
        operationId: link.operationId,
        sequence: 0,
        protectedData: {},
      } as TerminalServerMessage);
      await settle();
    });
    expect(fixture.writes).toHaveLength(1);
    const retirement = lifecycle.retireTransfer();
    await settle();
    expect(link.close).not.toHaveBeenCalled();
    await act(async () => {
      fixture.writes.shift()!();
      await retirement;
    });
    expect(link.close).toHaveBeenCalledWith("normal");
    await act(async () => {
      resume();
      await settle();
    });
  });

  it("drains accepted input before retiring, suppresses reconnect, and reattaches on cancellation", async () => {
    await mount();
    let finish!: (value: object) => void;
    fixture.protectInput.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    expect(fixture.input!("accepted")).toBe(true);
    await settle();
    const lifecycle = transfer.current!;
    const resume = lifecycle.suspendTransfer();
    expect(fixture.input!("too late")).toBe(false);
    const retired = lifecycle.retireTransfer();
    await settle();
    expect(fixture.links[0]!.close).not.toHaveBeenCalled();
    await act(async () => {
      finish({});
      await retired;
    });
    expect(
      fixture.send.mock.calls.filter(([message]) => message.type === "input"),
    ).toHaveLength(1);
    expect(fixture.links[0]!.close).toHaveBeenCalledWith("normal");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(fixture.links).toHaveLength(1);
    await act(async () => {
      resume();
      resume();
      await settle();
    });
    expect(fixture.links).toHaveLength(2);
    expect(fixture.renderers[0]!.disposed).toBe(true);
    expect(transfer.current).not.toBe(lifecycle);
    await expect(lifecycle.retireTransfer()).rejects.toThrow(/Suspend/);
  });

  it("resumes an unretired renderer without reconnecting or accepting suspended input", async () => {
    await mount();
    const lifecycle = transfer.current!;
    await expect(lifecycle.retireTransfer()).rejects.toThrow(/Suspend/);
    const resume = lifecycle.suspendTransfer();
    expect(() => lifecycle.suspendTransfer()).toThrow(/unavailable/);
    expect(fixture.input!("suspended")).toBe(false);
    resume();
    expect(fixture.input!("resumed")).toBe(true);
    await settle();
    expect(fixture.links).toHaveLength(1);
    expect(fixture.links[0]!.close).not.toHaveBeenCalled();
  });
  it("keeps the attachment open until transport delivery is acknowledged", async () => {
    await mount();
    let acknowledge!: () => void;
    fixture.drain.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    transfer.current!.suspendTransfer();
    const retirement = transfer.current!.retireTransfer();
    await settle();
    expect(fixture.drain).toHaveBeenCalledOnce();
    expect(fixture.links[0]!.close).not.toHaveBeenCalled();
    await act(async () => {
      acknowledge();
      await retirement;
    });
    expect(fixture.links[0]!.close).toHaveBeenCalledOnce();
  });

  it("rejects retirement when previously accepted input failed to send", async () => {
    await mount();
    fixture.protectInput.mockRejectedValueOnce(new Error("encryption failed"));
    expect(fixture.input!("accepted")).toBe(true);
    const resume = transfer.current!.suspendTransfer();
    await act(async () => {
      await expect(transfer.current!.retireTransfer()).rejects.toThrow(
        /could not be delivered/,
      );
    });
    expect(fixture.links[0]!.close).not.toHaveBeenCalled();
    await act(async () => {
      resume();
      await settle();
    });
    expect(fixture.links).toHaveLength(2);
  });
  it("does not let a cancelled retirement detach a newer suspension", async () => {
    await mount();
    const lifecycle = transfer.current!;
    const releaseFirst = lifecycle.suspendTransfer();
    const firstRetirement = lifecycle.retireTransfer();
    releaseFirst();
    lifecycle.suspendTransfer();
    await expect(firstRetirement).rejects.toThrow(/cancelled/);
    expect(fixture.links[0]!.close).not.toHaveBeenCalled();
    await lifecycle.retireTransfer();
    expect(fixture.links[0]!.close).toHaveBeenCalledOnce();
  });
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
