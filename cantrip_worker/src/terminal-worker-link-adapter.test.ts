import type {
  InstalledWorkerLinkGrant,
  SurfaceStreamOpaque,
  TerminalHydrationMetadata,
  TerminalOpenResult,
  WorkerLinkSession,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import { TerminalWorkerLinkAdapter } from "./terminal-worker-link-adapter.js";
import type { WorkerLinkAdapterEmitter } from "./worker-link-gateway.js";

const operationId = "11111111-1111-4111-8111-111111111111";
const channelId = "22222222-2222-4222-8222-222222222222";

const opaque: SurfaceStreamOpaque = {
  formatVersion: 1,
  keyRevision: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};

const hydration: TerminalHydrationMetadata = {
  cols: 80,
  format: "legacy-raw",
  generation: 2,
  rows: 24,
  snapshotCharacters: 17,
  snapshotChunks: 1,
  truncated: false,
  version: 1,
};

function authority(): {
  grant: InstalledWorkerLinkGrant;
  session: WorkerLinkSession;
} {
  const identity = {
    serverId: "server-1",
    serverGeneration: "server-generation-1",
    ownerId: "owner-1",
    accountSessionId: "account-session-1",
    clientInstanceId: "client-instance-1",
    workerId: "worker-1",
    workerProcessGeneration: "worker-generation-1",
  };
  const lease = {
    issuedAt: "2026-08-26T12:00:00.000Z",
    expiresAt: "2026-08-26T12:01:00.000Z",
    absoluteExpiresAt: "2026-08-26T13:00:00.000Z",
  };
  const session: WorkerLinkSession = {
    sessionId: "33333333-3333-4333-8333-333333333333",
    identity,
    lease,
    routePolicy: {
      priority: ["local", "lan", "wan", "relay"],
      enabled: ["local", "relay"],
    },
    routeGeneration: 1,
    preferredRoute: "local",
  };
  return {
    session,
    grant: {
      binding: {
        grantId: "44444444-4444-4444-8444-444444444444",
        grantGeneration: 1,
        sessionId: session.sessionId,
        identity,
        resource: {
          kind: "terminal",
          resourceId: "terminal-1",
          attachmentId: operationId,
        },
        lanes: ["interactive"],
        operations: ["stream:open", "stream:read", "stream:write"],
        maxChannels: 1,
        lease,
      },
      tokenHash: "a".repeat(64),
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("TerminalWorkerLinkAdapter", () => {
  it("preserves replay-before-ready ordering and resumes output on credit", async () => {
    const opened = deferred<TerminalOpenResult>();
    let runtimeEmit:
      | ((
          event:
            | { type: "terminal.ready" }
            | {
                type: "terminal.output";
                data: string;
                hydration?: TerminalHydrationMetadata;
              },
        ) => void)
      | null = null;
    const terminals = {
      attachExisting: vi.fn(
        (
          _terminalId: string,
          _attachmentId: string,
          emit: typeof runtimeEmit,
        ) => {
          runtimeEmit = emit;
          return opened.promise;
        },
      ),
      detach: vi.fn(() => ({ status: "detached" as const })),
      input: vi.fn(),
      resize: vi.fn(),
    };
    let writable = false;
    const sent: Uint8Array[] = [];
    const emit: WorkerLinkAdapterEmitter = {
      close: vi.fn(async () => true),
      data: vi.fn((payload) => {
        if (!writable) return false;
        sent.push(payload.slice());
        return true;
      }),
      error: vi.fn(() => true),
      halfClose: vi.fn(() => true),
    };
    const replay = {
      accept: vi.fn(),
      release: vi.fn(),
      reserve: vi.fn(),
    };
    const adapter = new TerminalWorkerLinkAdapter(terminals, {
      inputAllowed: () => true,
      openInput: vi.fn(async () => ({
        type: "terminal.input" as const,
        data: "input",
      })),
      protectOutput: vi.fn(async () => opaque),
      replay,
    });
    const { grant, session } = authority();
    const channel = await adapter.open({
      channel: {
        channelId,
        connectionId: "55555555-5555-4555-8555-555555555555",
      },
      grant,
      lane: "interactive",
      emit,
      session,
    });

    expect(terminals.attachExisting).toHaveBeenCalledWith(
      "terminal-1",
      `worker-link:${channelId}`,
      expect.any(Function),
    );

    runtimeEmit!({
      type: "terminal.output",
      data: "historical output",
      hydration,
    });
    runtimeEmit!({ type: "terminal.ready" });
    await vi.waitFor(() => expect(emit.data).toHaveBeenCalled());
    expect(sent).toHaveLength(0);

    writable = true;
    channel.credit?.(1024);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const decoded = sent.map((payload) =>
      JSON.parse(new TextDecoder().decode(payload)),
    );
    expect(decoded.map((message) => message.type)).toEqual(["output", "ready"]);
    expect(decoded[0]).toMatchObject({ hydration });

    opened.resolve({ status: "exited", exitCode: 0, signal: null });
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(JSON.parse(new TextDecoder().decode(sent[2]!))).toMatchObject({
      type: "exit",
      exitCode: 0,
    });
    expect(emit.close).toHaveBeenCalledWith("normal");
  });

  it("opens protected input in sequence and detaches on close", async () => {
    const opened = deferred<TerminalOpenResult>();
    const terminals = {
      attachExisting: vi.fn(() => opened.promise),
      detach: vi.fn(() => ({ status: "detached" as const })),
      input: vi.fn(),
      resize: vi.fn(),
    };
    const replay = {
      accept: vi.fn(),
      release: vi.fn(),
      reserve: vi.fn(),
    };
    const openInput = vi.fn(async () => ({
      type: "terminal.input" as const,
      data: "ls\r",
    }));
    const adapter = new TerminalWorkerLinkAdapter(terminals, {
      inputAllowed: () => true,
      openInput,
      protectOutput: vi.fn(async () => opaque),
      replay,
    });
    const { grant, session } = authority();
    const channel = await adapter.open({
      channel: {
        channelId,
        connectionId: "55555555-5555-4555-8555-555555555555",
      },
      grant,
      lane: "interactive",
      emit: {
        close: vi.fn(async () => true),
        data: vi.fn(() => true),
        error: vi.fn(() => true),
        halfClose: vi.fn(() => true),
      },
      session,
    });
    const payload = new TextEncoder().encode(
      JSON.stringify({
        type: "input",
        operationId,
        sequence: 0,
        protectedData: opaque,
      }),
    );

    await channel.write?.(payload);
    expect(replay.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ operationId, sequence: 0 }),
    );
    expect(openInput).toHaveBeenCalledOnce();
    expect(terminals.input).toHaveBeenCalledWith("terminal-1", "ls\r");
    expect(replay.accept).toHaveBeenCalledWith(
      expect.objectContaining({ operationId, sequence: 0 }),
      false,
    );

    await channel.write?.(
      new TextEncoder().encode(
        JSON.stringify({ type: "resize", cols: 132, rows: 40 }),
      ),
    );
    expect(terminals.resize).toHaveBeenCalledWith("terminal-1", 132, 40);
    await channel.close?.("normal");
    expect(terminals.detach).toHaveBeenCalledWith(
      "terminal-1",
      `worker-link:${channelId}`,
    );
    expect(replay.release).toHaveBeenCalledWith(
      expect.objectContaining({ operationId, direction: "input" }),
    );
  });
});
