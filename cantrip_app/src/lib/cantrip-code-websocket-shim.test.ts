import { afterEach, describe, expect, it, vi } from "vitest";

import shimSource from "../../public/cantrip-code-websocket-shim.js?raw";

const ADAPTER_ID = "11111111-1111-4111-8111-111111111111";
const FRAME_NONCE = "websocket_shim_frame_nonce_1234";
const GENERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINEAGE_TOKEN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORIGIN = "https://cantrip.example";
const MAX_QUEUED_SOCKET_BYTES = 8 * 1_024 * 1_024;
const MAX_QUEUED_SOCKET_OPERATIONS = 1_024;
const MAX_QUEUED_SESSION_BYTES = 32 * 1_024 * 1_024;

interface ShimSocket extends EventTarget {
  readonly socketId: string;
  readonly url: string;
  bufferedAmount: number;
  onclose: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
  protocol: string;
  readyState: number;
  close(code?: number, reason?: string): void;
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void;
}

interface ShimSocketConstructor {
  new (url: string | URL, protocols?: string | string[]): ShimSocket;
  readonly CLOSED: number;
  readonly CLOSING: number;
  readonly CONNECTING: number;
  readonly OPEN: number;
}

interface ParentMessage {
  adapterId?: string;
  binary?: boolean;
  data?: unknown;
  frameNonce?: string;
  generation?: string;
  socketId?: string;
  type?: string;
}

class TestCloseEvent extends Event {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;

  constructor(
    type: string,
    init: { code?: number; reason?: string; wasClean?: boolean } = {},
  ) {
    super(type);
    this.code = init.code ?? 0;
    this.reason = init.reason ?? "";
    this.wasClean = init.wasClean ?? false;
  }
}

function messageEvent(data: unknown, source: object): Event {
  const event = new Event("message");
  Object.defineProperties(event, {
    data: { value: data },
    origin: { value: ORIGIN },
    source: { value: source },
  });
  return event;
}

function createHarness(options: { nested?: boolean } = {}): {
  NativeWebSocket: new () => object;
  WebSocket: ShimSocketConstructor;
  dispatchParent: (message: Record<string, unknown>) => void;
  failNextPost: () => void;
  intermediatePost: ReturnType<typeof vi.fn>;
  messages: ParentMessage[];
  window: EventTarget & Record<string, unknown>;
} {
  const messages: ParentMessage[] = [];
  const relayPost = vi.fn((message: ParentMessage) => messages.push(message));
  const relay = {
    postMessage: relayPost,
  };
  const intermediatePost = vi.fn();
  const parent = options.nested ? { postMessage: intermediatePost } : relay;
  class NativeWebSocket {}
  const browserWindow = new EventTarget() as EventTarget &
    Record<string, unknown>;
  Object.assign(browserWindow, {
    location: {
      href: `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/`,
      origin: ORIGIN,
      pathname: `/__cantrip_code/${ADAPTER_ID}/code/`,
    },
    parent,
    top: relay,
    WebSocket: NativeWebSocket,
  });

  let socketSequence = 0;
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("location", browserWindow.location);
  vi.stubGlobal("document", {
    querySelector: () => ({
      getAttribute: () => `${GENERATION}:${FRAME_NONCE}:${LINEAGE_TOKEN}`,
    }),
  });
  vi.stubGlobal("crypto", {
    randomUUID: () =>
      `22222222-2222-4222-8222-${String(++socketSequence).padStart(12, "0")}`,
  });
  vi.stubGlobal("CloseEvent", TestCloseEvent);
  (0, eval)(shimSource);
  browserWindow.dispatchEvent(
    messageEvent(
      {
        adapterId: ADAPTER_ID,
        frameNonce: FRAME_NONCE,
        generation: GENERATION,
        type: "cantrip-code-worker-lineage-accepted-v2",
      },
      relay,
    ),
  );

  return {
    NativeWebSocket,
    WebSocket: browserWindow.WebSocket as ShimSocketConstructor,
    dispatchParent: (message) =>
      browserWindow.dispatchEvent(messageEvent(message, relay)),
    failNextPost: () =>
      relayPost.mockImplementationOnce(() => {
        throw new Error("parent delivery failed");
      }),
    intermediatePost,
    messages,
    window: browserWindow,
  };
}

function openSocket(
  harness: ReturnType<typeof createHarness>,
  protocols?: string | string[],
): ShimSocket {
  const socket = new harness.WebSocket(
    "wss://worker.example/socket",
    protocols,
  );
  harness.dispatchParent({
    adapterId: ADAPTER_ID,
    event: "open",
    frameNonce: FRAME_NONCE,
    generation: GENERATION,
    protocol: "",
    socketId: socket.socketId,
    type: "cantrip-code-websocket-event-v1",
  });
  expect(socket.readyState).toBe(harness.WebSocket.OPEN);
  return socket;
}

function acknowledge(
  harness: ReturnType<typeof createHarness>,
  socket: ShimSocket,
  byteLength: number,
): void {
  harness.dispatchParent({
    adapterId: ADAPTER_ID,
    byteLength,
    event: "send-ack",
    frameNonce: FRAME_NONCE,
    generation: GENERATION,
    socketId: socket.socketId,
    type: "cantrip-code-websocket-event-v1",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Cantrip Code WebSocket shim", () => {
  it("wraps the real blob-backed extension host with exact worker lineage", async () => {
    const frameNonce = "websocket_shim_frame_nonce_1234";
    const generation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const lineageToken = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const relayPost = vi.fn();
    const relay = { postMessage: relayPost };
    const constructed: Array<{
      kind: "shared" | "worker";
      options: unknown;
      url: string;
    }> = [];
    class NativeWorker {
      constructor(url: string | URL, options?: unknown) {
        constructed.push({ kind: "worker", options, url: String(url) });
      }
    }
    class NativeSharedWorker {
      constructor(url: string | URL, options?: unknown) {
        constructed.push({ kind: "shared", options, url: String(url) });
      }
    }
    class NativeWebSocket {}
    const browserWindow = new EventTarget() as EventTarget &
      Record<string, unknown>;
    Object.assign(browserWindow, {
      location: {
        href: `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/`,
        origin: ORIGIN,
        pathname: `/__cantrip_code/${ADAPTER_ID}/code/`,
      },
      parent: relay,
      top: relay,
      WebSocket: NativeWebSocket,
      Worker: NativeWorker,
      SharedWorker: NativeSharedWorker,
    });
    const workerBlobs: Blob[] = [];
    const workerUrls: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      if (!(blob instanceof Blob)) throw new Error("Expected a worker Blob.");
      workerBlobs.push(blob);
      const url = `${ORIGIN.replace("https:", "blob:https:")}/worker-${workerBlobs.length}`;
      workerUrls.push(url);
      return url;
    });
    const revokeObjectUrl = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    vi.stubGlobal("window", browserWindow);
    vi.stubGlobal("location", browserWindow.location);
    const serviceWorkerController = { postMessage: vi.fn() };
    const serviceWorkerContainer = Object.assign(new EventTarget(), {
      controller: serviceWorkerController,
    });
    vi.stubGlobal("navigator", { serviceWorker: serviceWorkerContainer });
    vi.stubGlobal("document", {
      querySelector: () => ({
        getAttribute: () => `${generation}:${frameNonce}:${lineageToken}`,
      }),
    });

    (0, eval)(shimSource);
    browserWindow.dispatchEvent(
      messageEvent(
        {
          adapterId: ADAPTER_ID,
          frameNonce,
          generation,
          type: "cantrip-code-worker-lineage-accepted-v2",
        },
        relay,
      ),
    );
    const Worker = browserWindow.Worker as new (
      url: string,
      options?: { type?: string },
    ) => NativeWorker;
    const originalUrl = URL.createObjectURL(
      new Blob(["extension host"], { type: "application/javascript" }),
    );
    expect(new Worker(originalUrl)).toBeInstanceOf(NativeWorker);
    URL.revokeObjectURL(originalUrl);

    expect(constructed).toEqual([
      {
        kind: "worker",
        options: undefined,
        url: workerUrls[2],
      },
    ]);
    expect(workerBlobs).toHaveLength(3);
    const source = await workerBlobs[2]!.text();
    expect(source).toContain(workerUrls[1]);
    expect(source).not.toContain(originalUrl);
    expect(source).toContain('"revokeOriginalUrl":true');
    expect(source).toContain("__cantrip_client_register_v2");
    expect(source).toContain(generation);
    expect(source).toContain(frameNonce);
    expect(source).toContain(lineageToken);
    expect(relayPost).toHaveBeenCalledWith(
      {
        adapterId: ADAPTER_ID,
        frameNonce,
        generation,
        lineageToken,
        type: "cantrip-code-worker-lineage-v2",
      },
      ORIGIN,
    );
    expect(revokeObjectUrl).toHaveBeenCalledWith(originalUrl);
    serviceWorkerContainer.dispatchEvent(
      messageEvent(
        {
          adapterId: ADAPTER_ID,
          challenge: "exact-client-challenge",
          frameNonce,
          generation,
          type: "cantrip-code-client-lineage-challenge-v2",
        },
        serviceWorkerController,
      ),
    );
    expect(serviceWorkerController.postMessage).toHaveBeenCalledWith({
      adapterId: ADAPTER_ID,
      challenge: "exact-client-challenge",
      frameNonce,
      generation,
      lineageToken,
      type: "cantrip-code-client-lineage-response-v2",
    });

    const SharedWorker = browserWindow.SharedWorker as new (
      url: string,
      options?: { name?: string; type?: string },
    ) => NativeSharedWorker;
    const sharedOriginalUrl = URL.createObjectURL(
      new Blob(["shared extension host"], {
        type: "application/javascript",
      }),
    );
    expect(
      new SharedWorker(sharedOriginalUrl, { name: "extension-host" }),
    ).toBeInstanceOf(NativeSharedWorker);
    URL.revokeObjectURL(sharedOriginalUrl);
    expect(
      new SharedWorker(sharedOriginalUrl, { name: "extension-host" }),
    ).toBeInstanceOf(NativeSharedWorker);
    const sharedConstructions = constructed.filter(
      ({ kind }) => kind === "shared",
    );
    expect(sharedConstructions).toHaveLength(2);
    expect(sharedConstructions[0]!.url).toBe(sharedConstructions[1]!.url);
    expect(workerBlobs).toHaveLength(6);
    const sharedSource = await workerBlobs[5]!.text();
    expect(sharedSource).toContain(workerUrls[4]);
    expect(sharedSource).toContain('"revokeOriginalUrl":false');

    const protectedWorkerUrl = `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/extensionHostWorker.js`;
    expect(new Worker(protectedWorkerUrl, { type: "module" })).toBeInstanceOf(
      NativeWorker,
    );
    expect(workerBlobs).toHaveLength(7);
    expect(await workerBlobs[6]!.text()).toContain(protectedWorkerUrl);
    expect(new Worker(`${ORIGIN}/ordinary-worker.js`)).toBeInstanceOf(
      NativeWorker,
    );
    expect(constructed.at(-1)).toMatchObject({
      kind: "worker",
      url: `${ORIGIN}/ordinary-worker.js`,
    });
    expect(workerBlobs).toHaveLength(7);

    const workerGlobal = new EventTarget() as EventTarget & {
      location: { origin: string };
    };
    workerGlobal.location = { origin: ORIGIN };
    const workerFetch = vi.fn().mockResolvedValue({ status: 204 });
    const importScripts = vi.fn();
    vi.stubGlobal("self", workerGlobal);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("fetch", workerFetch);
    vi.stubGlobal("importScripts", importScripts);
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal("SharedWorker", undefined);
    (0, eval)(source);
    await vi.waitFor(() => expect(importScripts).toHaveBeenCalledOnce());
    expect(workerFetch).toHaveBeenCalledWith(
      `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/__cantrip_client_register_v2`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(importScripts).toHaveBeenCalledWith(workerUrls[1]);

    await globalThis.fetch(`${ORIGIN}/worker-resource.json`);
    expect(workerFetch).toHaveBeenCalledTimes(3);
  });

  it("routes nested workbench sockets directly to the bound top-level owner", () => {
    const harness = createHarness({ nested: true });

    const socket = openSocket(harness);
    socket.send("nested");

    expect(harness.intermediatePost).not.toHaveBeenCalled();
    expect(harness.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          frameNonce: FRAME_NONCE,
          generation: GENERATION,
          socketId: socket.socketId,
          type: "cantrip-code-websocket-open-v1",
        }),
        expect.objectContaining({
          data: "nested",
          frameNonce: FRAME_NONCE,
          generation: GENERATION,
          socketId: socket.socketId,
          type: "cantrip-code-websocket-send-v1",
        }),
      ]),
    );
  });

  it("fences every socket command and event to the exact frame generation", () => {
    const harness = createHarness();
    const socket = new harness.WebSocket("wss://worker.example/socket");

    harness.dispatchParent({
      adapterId: ADAPTER_ID,
      event: "open",
      frameNonce: FRAME_NONCE,
      generation: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      protocol: "",
      socketId: socket.socketId,
      type: "cantrip-code-websocket-event-v1",
    });
    harness.dispatchParent({
      adapterId: ADAPTER_ID,
      event: "open",
      frameNonce: "stale_websocket_frame_nonce_1234",
      generation: GENERATION,
      protocol: "",
      socketId: socket.socketId,
      type: "cantrip-code-websocket-event-v1",
    });
    expect(socket.readyState).toBe(harness.WebSocket.CONNECTING);

    harness.dispatchParent({
      adapterId: ADAPTER_ID,
      event: "open",
      frameNonce: FRAME_NONCE,
      generation: GENERATION,
      protocol: "",
      socketId: socket.socketId,
      type: "cantrip-code-websocket-event-v1",
    });
    socket.send("fenced");
    socket.close(1000, "done");

    const commands = harness.messages.filter((message) =>
      message.type?.startsWith("cantrip-code-websocket-"),
    );
    expect(commands.map((message) => message.type)).toEqual([
      "cantrip-code-websocket-open-v1",
      "cantrip-code-websocket-send-v1",
      "cantrip-code-websocket-close-v1",
    ]);
    expect(commands).toEqual(
      commands.map((message) =>
        expect.objectContaining({
          frameNonce: FRAME_NONCE,
          generation: GENERATION,
        }),
      ),
    );
  });

  it.each([
    {
      byteLength: 2,
      label: "UTF-8 string",
      payload: "é" as string | ArrayBuffer | Blob,
    },
    {
      byteLength: 3,
      label: "ArrayBuffer",
      payload: new Uint8Array([1, 2, 3]).buffer as string | ArrayBuffer | Blob,
    },
    {
      byteLength: 4,
      label: "Blob",
      payload: new Blob([new Uint8Array([1, 2, 3, 4])]) as
        string | ArrayBuffer | Blob,
    },
  ])(
    "keeps $label bytes buffered until the parent acknowledges them",
    async ({ byteLength, payload }) => {
      const harness = createHarness();
      const socket = openSocket(harness);

      socket.send(payload);

      expect(socket.bufferedAmount).toBe(byteLength);
      await Promise.resolve();
      await Promise.resolve();
      expect(socket.bufferedAmount).toBe(byteLength);

      acknowledge(harness, socket, byteLength);
      expect(socket.bufferedAmount).toBe(0);
    },
  );

  it("caps each socket's queued bytes without failing another socket", () => {
    const harness = createHarness();
    const overflowing = openSocket(harness);
    const healthy = openSocket(harness);
    const onError = vi.fn();
    const onClose = vi.fn();
    const healthyError = vi.fn();
    const healthyClose = vi.fn();
    overflowing.onerror = onError;
    overflowing.onclose = onClose;
    healthy.onerror = healthyError;
    healthy.onclose = healthyClose;
    const chunk = new ArrayBuffer(1 * 1_024 * 1_024);

    for (let index = 0; index < 9; index += 1) overflowing.send(chunk);

    const overflowingSends = harness.messages.filter(
      (message) =>
        message.type === "cantrip-code-websocket-send-v1" &&
        message.socketId === overflowing.socketId,
    );
    expect(overflowingSends).toHaveLength(8);
    expect(overflowing.bufferedAmount).toBeLessThanOrEqual(
      MAX_QUEUED_SOCKET_BYTES,
    );
    expect(overflowing.readyState).toBe(harness.WebSocket.CLOSED);
    expect(onError).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();

    expect(healthy.readyState).toBe(harness.WebSocket.OPEN);
    expect(healthyError).not.toHaveBeenCalled();
    expect(healthyClose).not.toHaveBeenCalled();
    healthy.send("still connected");
    expect(healthy.bufferedAmount).toBe(
      new TextEncoder().encode("still connected").byteLength,
    );
  });

  it("caps synchronous queued bytes across sockets before parent delivery", () => {
    const harness = createHarness();
    const sockets = Array.from({ length: 5 }, () => openSocket(harness));
    const errors = sockets.map(() => vi.fn());
    const closes = sockets.map(() => vi.fn());
    for (const [index, socket] of sockets.entries()) {
      socket.onerror = errors[index]!;
      socket.onclose = closes[index]!;
    }
    const chunk = new ArrayBuffer(7 * 1_024 * 1_024);

    for (const socket of sockets) socket.send(chunk);

    expect(
      harness.messages.filter(
        (message) => message.type === "cantrip-code-websocket-send-v1",
      ),
    ).toHaveLength(4);
    expect(sockets.slice(0, 4).every((socket) => socket.readyState === 1)).toBe(
      true,
    );
    expect(sockets[4]!.readyState).toBe(harness.WebSocket.CLOSED);
    expect(
      errors.slice(0, 4).every((error) => error.mock.calls.length === 0),
    ).toBe(true);
    expect(
      closes.slice(0, 4).every((close) => close.mock.calls.length === 0),
    ).toBe(true);
    expect(errors[4]).toHaveBeenCalledOnce();
    expect(closes[4]).toHaveBeenCalledOnce();
    expect(
      sockets
        .slice(0, 4)
        .reduce((sum, socket) => sum + socket.bufferedAmount, 0),
    ).toBeLessThanOrEqual(MAX_QUEUED_SESSION_BYTES);

    acknowledge(harness, sockets[0]!, chunk.byteLength);
    const replacement = openSocket(harness);
    replacement.send(chunk);
    expect(replacement.readyState).toBe(harness.WebSocket.OPEN);
  });

  it("continues the socket queue after one parent delivery rejects", () => {
    const harness = createHarness();
    const socket = openSocket(harness);
    const onError = vi.fn();
    socket.onerror = onError;

    harness.failNextPost();
    socket.send("failed");
    socket.send("after");

    expect(onError).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(harness.WebSocket.OPEN);
    expect(
      harness.messages.filter(
        (message) =>
          message.type === "cantrip-code-websocket-send-v1" &&
          message.socketId === socket.socketId,
      ),
    ).toEqual([
      expect.objectContaining({
        binary: false,
        data: "after",
      }),
    ]);
    expect(socket.bufferedAmount).toBe(5);

    acknowledge(harness, socket, 5);
    expect(socket.bufferedAmount).toBe(0);
  });

  it("uses intrinsic Blob size and bytes instead of subclass overrides", async () => {
    const harness = createHarness();
    const socket = openSocket(harness);
    const onError = vi.fn();
    socket.onerror = onError;
    class LyingBlob extends Blob {
      override get size(): number {
        return 1;
      }

      override arrayBuffer(): Promise<ArrayBuffer> {
        return Promise.resolve(new ArrayBuffer(MAX_QUEUED_SOCKET_BYTES + 1));
      }
    }

    socket.send(new LyingBlob(["safe"]));

    expect(socket.bufferedAmount).toBe(4);
    await vi.waitFor(() =>
      expect(
        harness.messages.filter(
          (message) =>
            message.type === "cantrip-code-websocket-send-v1" &&
            message.socketId === socket.socketId,
        ),
      ).toHaveLength(1),
    );
    expect(onError).not.toHaveBeenCalled();
    expect(
      harness.messages.filter(
        (message) =>
          message.type === "cantrip-code-websocket-send-v1" &&
          message.socketId === socket.socketId,
      ),
    ).toEqual([
      expect.objectContaining({
        binary: true,
        data: expect.objectContaining({ byteLength: 4 }),
      }),
    ]);
    expect(socket.bufferedAmount).toBe(4);

    acknowledge(harness, socket, 4);
    expect(socket.bufferedAmount).toBe(0);
  });

  it("rejects a Blob length mismatch before posting it to the parent", async () => {
    vi.spyOn(Blob.prototype, "arrayBuffer").mockImplementation(function (
      this: Blob,
    ) {
      return Promise.resolve(new ArrayBuffer(this.size + 1));
    });
    const harness = createHarness();
    const socket = openSocket(harness);
    const onError = vi.fn();
    socket.onerror = onError;

    socket.send(new Blob(["x"]));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(socket.readyState).toBe(harness.WebSocket.OPEN);
    expect(socket.bufferedAmount).toBe(0);
    expect(
      harness.messages.filter(
        (message) =>
          message.type === "cantrip-code-websocket-send-v1" &&
          message.socketId === socket.socketId,
      ),
    ).toHaveLength(0);
  });

  it("caps outstanding operations even when their queued byte length is zero", () => {
    const harness = createHarness();
    const overflowing = openSocket(harness);
    const healthy = openSocket(harness);
    const onError = vi.fn();
    const onClose = vi.fn();
    overflowing.onerror = onError;
    overflowing.onclose = onClose;
    class NeverSettlingBlob extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        return new Promise(() => undefined);
      }
    }

    overflowing.send(new NeverSettlingBlob(["x"]));
    for (let index = 1; index < MAX_QUEUED_SOCKET_OPERATIONS; index += 1) {
      overflowing.send("");
    }
    expect(overflowing.readyState).toBe(harness.WebSocket.OPEN);

    overflowing.send("");

    expect(overflowing.readyState).toBe(harness.WebSocket.CLOSED);
    expect(onError).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(healthy.readyState).toBe(harness.WebSocket.OPEN);
    healthy.send("still connected");
    expect(healthy.bufferedAmount).toBe(15);
  });

  it.each([
    { label: "duplicate", protocols: ["chat", "chat"] },
    { label: "case-insensitive duplicate", protocols: ["chat", "CHAT"] },
    { label: "invalid token", protocols: ["bad protocol"] },
    { label: "CRLF injection", protocols: ["chat\r\nX-Evil: yes"] },
  ])("rejects $label subprotocols synchronously", ({ protocols }) => {
    const harness = createHarness();

    expect(
      () => new harness.WebSocket("wss://worker.example/socket", protocols),
    ).toThrow();
    expect(
      harness.messages.filter((message) =>
        message.type?.startsWith("cantrip-code-websocket-"),
      ),
    ).toHaveLength(0);
  });

  it("does not expose the native WebSocket constructor", () => {
    const harness = createHarness();

    expect(harness.window.WebSocket).not.toBe(harness.NativeWebSocket);
    expect("__cantripNativeWebSocket" in harness.window).toBe(false);
  });

  it("does not resurrect a locally closed socket after a late open", () => {
    const harness = createHarness();
    const socket = new harness.WebSocket("wss://worker.example/socket");
    const onOpen = vi.fn();
    socket.onopen = onOpen;

    socket.close(1000, "closed before relay handshake");
    expect(socket.readyState).toBe(harness.WebSocket.CLOSING);
    harness.dispatchParent({
      adapterId: ADAPTER_ID,
      event: "open",
      frameNonce: FRAME_NONCE,
      generation: GENERATION,
      protocol: "",
      socketId: socket.socketId,
      type: "cantrip-code-websocket-event-v1",
    });

    expect(socket.readyState).not.toBe(harness.WebSocket.OPEN);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
