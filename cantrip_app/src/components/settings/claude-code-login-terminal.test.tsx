import {
  terminalInputContentSchema,
  terminalOutputContentSchema,
} from "@cantrip/protocol/surface-stream";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  openSurfaceStreamContent,
  protectSurfaceStreamContent,
} from "@/lib/surface-stream-encryption";

import { ClaudeCodeLoginTerminal } from "./claude-code-login-terminal";

const workerId = "worker-local";
const auth = vi.hoisted(() => ({ grant: vi.fn(), refresh: vi.fn() }));
const terminal = vi.hoisted(() => ({ onData: vi.fn(), write: vi.fn() }));

vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => ({
    userId: "owner",
    serverId: "server",
  }),
  clientSessionIdentityMatches: () => true,
  getClientSession: () => ({ user: { id: "owner" }, serverId: "server" }),
}));
vi.mock("@/lib/client-encryption", () => ({
  clientEncryption: {
    componentKey: () => new Uint8Array(32).fill(1),
    getSnapshot: () => ({
      status: "ready",
      masterKeyRevision: 1,
      identity: { ownerId: "owner", serverId: "server" },
    }),
  },
}));
vi.mock("@/lib/server-connections", () => ({
  getActiveServerUrl: () => "https://cantrip.test",
}));
vi.mock("@/lib/api/worker-wire", () => ({
  refreshWorkerEncryption: auth.refresh,
}));
vi.mock("@/lib/worker-encryption-grants", () => ({
  authorizeWorkerEncryption: auth.grant,
}));
vi.mock("@/components/terminal/terminal-link-layer", () => ({
  installTerminalLinkLayer: () => ({ dispose() {}, refresh() {} }),
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    write = terminal.write;
    onData(listener: (value: string) => void) {
      terminal.onData(listener);
      return { dispose() {} };
    }
  },
}));

class Socket {
  static OPEN = 1;
  static current: Socket;
  readyState = Socket.OPEN;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  close = vi.fn();
  send = vi.fn();

  constructor(readonly url: URL) {
    Socket.current = this;
  }

  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe("Claude Code sign-in terminal", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function start() {
    const complete = vi.fn();
    let view!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      view = TestRenderer.create(
        <ClaudeCodeLoginTerminal
          providerId="provider"
          accountId="account"
          workerId={workerId}
          onSignedIn={complete}
        />,
        { createNodeMock: () => ({}) },
      );
    });
    const socket = Socket.current;
    expect(auth.grant).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId,
        components: ["surface-private-state"],
      }),
    );
    expect(socket.url.pathname).toBe(
      "/api/settings/providers/provider/accounts/account/claude-login/connect",
    );
    expect(socket.url.searchParams.get("operationId")).toBeTruthy();
    return { view, complete, socket };
  }

  it("decrypts the login prompt and encrypts terminal input for the same operation", async () => {
    const { view, socket } = await start();
    const operationId = socket.url.searchParams.get("operationId")!;
    const context = {
      surfaceKind: "terminal" as const,
      surfaceId: `claude-login:${operationId}`,
      operationId,
      sequence: 0,
    };
    const protectedData = await protectSurfaceStreamContent({
      context: { ...context, direction: "output" },
      schema: terminalOutputContentSchema,
      content: { type: "terminal.output", data: "Fixture prompt" },
    });
    await act(async () => {
      socket.receive({
        type: "output",
        operationId,
        sequence: 0,
        protectedData,
      });
      socket.receive({ type: "ready" });
    });
    await vi.waitFor(() =>
      expect(terminal.write).toHaveBeenCalledWith(
        "Fixture prompt",
        expect.any(Function),
      ),
    );
    await act(async () => terminal.onData.mock.calls[0]![0]("fixture code"));
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(2));
    const input = JSON.parse(socket.send.mock.lastCall![0]);
    expect(input).toMatchObject({ type: "input", operationId, sequence: 0 });
    expect(input).not.toHaveProperty("data");
    expect(
      await openSurfaceStreamContent({
        context: { ...context, direction: "input" },
        opaque: input.protectedData,
        schema: terminalInputContentSchema,
      }),
    ).toEqual({ type: "terminal.input", data: "fixture code" });
    await act(async () => view.unmount());
  });

  it("closes only after the worker confirms sign-in", async () => {
    const { view, complete, socket } = await start();
    await act(async () => socket.receive({ type: "ready" }));
    expect(complete).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "resize", cols: 80, rows: 24 }),
    );
    await act(async () =>
      socket.receive({ type: "exit", exitCode: 0, signal: null }),
    );
    expect(complete).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalled();
    await act(async () => view.unmount());
  });

  it("keeps the failure visible and closes a cancelled attempt", async () => {
    const { view, complete, socket } = await start();
    await act(async () =>
      socket.receive({ type: "exit", exitCode: 1, signal: null }),
    );
    expect(complete).not.toHaveBeenCalled();
    expect(view.root.findByProps({ role: "alert" }).props.children).toContain(
      "did not complete",
    );
    await act(async () => view.unmount());

    const next = await start();
    expect(next.socket.url.search).not.toBe(socket.url.search);
    await act(async () => next.view.unmount());
    expect(next.socket.close).toHaveBeenCalledOnce();
    expect(next.complete).not.toHaveBeenCalled();
  });
});
