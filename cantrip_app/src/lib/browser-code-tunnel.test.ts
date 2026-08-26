import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeTunnelDataPlaneFrame,
  encodeTunnelDataPlaneFrame,
  TUNNEL_DATA_PLANE_MAX_PLAINTEXT_BYTES,
  type CodeProtectedAttachmentWire,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import type { BoundExplorerCodeSessionAttachment } from "@/lib/api";

const mocks = vi.hoisted(() => {
  const clientIdentityListeners = new Set<() => void>();
  const serverIdentityListeners = new Set<() => void>();
  return {
    clientIdentityListeners,
    createTunnelAttachment: vi.fn(),
    deleteTunnelAttachment: vi.fn(),
    explorerCodeSessionBindingCurrent: vi.fn(),
    getActiveServerConnection: vi.fn(),
    getActiveServerUrl: vi.fn(),
    getClientSession: vi.fn(),
    getTunnelTransportConfiguration: vi.fn(),
    onClientSessionIdentityChanged: vi.fn((listener: () => void) => {
      clientIdentityListeners.add(listener);
      return () => clientIdentityListeners.delete(listener);
    }),
    onServerConnectionIdentityChanged: vi.fn((listener: () => void) => {
      serverIdentityListeners.add(listener);
      return () => serverIdentityListeners.delete(listener);
    }),
    serverIdentityListeners,
  };
});

vi.mock("@/lib/api", () => ({
  createTunnelAttachment: mocks.createTunnelAttachment,
  deleteTunnelAttachment: mocks.deleteTunnelAttachment,
  explorerCodeSessionBindingCurrent: mocks.explorerCodeSessionBindingCurrent,
  getTunnelTransportConfiguration: mocks.getTunnelTransportConfiguration,
}));

vi.mock("@/lib/browser-code-worker-link-socket", () => ({
  BROWSER_CODE_TUNNEL_SOCKET_CLOSED: 3,
  BROWSER_CODE_TUNNEL_SOCKET_OPEN: 1,
  createBrowserCodeWorkerLinkSocket: (input: { attachmentId: string }) =>
    new WebSocket(
      `wss://cantrip.example/api/tunnel-attachments/${input.attachmentId}/connect`,
    ),
}));

vi.mock("@/lib/server-connections", () => ({
  getActiveServerConnection: mocks.getActiveServerConnection,
  getActiveServerUrl: mocks.getActiveServerUrl,
  onServerConnectionIdentityChanged: mocks.onServerConnectionIdentityChanged,
}));

vi.mock("@/lib/client-session", () => ({
  getClientSession: mocks.getClientSession,
  onClientSessionIdentityChanged: mocks.onClientSessionIdentityChanged,
}));

import {
  browserCodeAttachmentHealthy,
  bindBrowserCodeAttachmentFrame,
  browserCodeTunnelRuntime,
  compactBrowserCodeBufferTail,
  proxyBrowserCodeHttp,
  sharedBrowserCodeAttachmentHealthy,
  startBrowserCodeAttachment,
  startSharedBrowserCodeAttachment,
  stopBrowserCodeAttachment,
  stopSharedBrowserCodeAttachment,
  subscribeBrowserCodeAttachmentUnavailable,
} from "./browser-code-tunnel";

describe("browser Code buffer compaction", () => {
  it("right-sizes a retained tail instead of pinning its consumed backing buffer", () => {
    const source = new Uint8Array(8 * 1_024 * 1_024);
    source[source.byteLength - 1] = 73;

    const tail = compactBrowserCodeBufferTail(source, source.byteLength - 1);

    expect([...tail]).toEqual([73]);
    expect(tail.byteLength).toBe(1);
    expect(tail.buffer.byteLength).toBe(1);
  });
});

const TUNNEL_ID = "11111111-1111-4111-8111-111111111111";
const FRAME_NONCE = "browser_code_frame_nonce_1234";
const attachmentTunnels = new Map<string, string>();
const sockets: FakeWebSocket[] = [];
let attachmentSequence = 0;
let autoOpenSockets = true;
let autoReadySockets = true;
const destinationEndpointIds: string[] = [];

class FakeMessagePort extends EventTarget {
  readonly messages: unknown[] = [];
  closed = false;
  peer: FakeMessagePort | null = null;

  close(): void {
    this.closed = true;
  }

  postMessage(message: unknown): void {
    if (this.closed || !this.peer || this.peer.closed) return;
    this.peer.messages.push(message);
    this.peer.dispatchEvent(new MessageEvent("message", { data: message }));
  }

  receive(message: unknown): void {
    this.postMessage(message);
  }

  start(): void {}
}

class FakeMessageChannel {
  readonly port1 = new FakeMessagePort();
  readonly port2 = new FakeMessagePort();

  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

const adapterPorts = new Map<string, FakeMessagePort>();
const adapterRegistrationMessages: Array<{
  adapterId: string;
  frameNonce?: string;
  generation: string;
  lineageToken?: string;
  rootLease: string;
}> = [];
let rejectAdapterRegistrations = false;
function fakeServiceWorkerEndpoint(protocolV2 = true) {
  return {
    postMessage(
      message: {
        adapterId?: string;
        generation?: string;
        rootLease?: string;
        type?: string;
      },
      transfer: Transferable[] = [],
    ) {
      if (message.type === "cantrip-code-adapter-protocol-probe-v2") {
        if (!protocolV2) return;
        const port = transfer[0] as unknown as FakeMessagePort;
        port.postMessage({
          type: "cantrip-code-adapter-protocol-ready-v2",
          version: 2,
        });
        port.close();
        return;
      }
      if (
        message.type !== "cantrip-code-adapter-register-v2" ||
        typeof message.adapterId !== "string" ||
        typeof message.generation !== "string" ||
        typeof message.rootLease !== "string"
      ) {
        return;
      }
      const port = transfer[0] as unknown as FakeMessagePort;
      adapterRegistrationMessages.push({
        adapterId: message.adapterId,
        generation: message.generation,
        rootLease: message.rootLease,
        ...(typeof Reflect.get(message, "frameNonce") === "string" &&
        typeof Reflect.get(message, "lineageToken") === "string"
          ? {
              frameNonce: Reflect.get(message, "frameNonce") as string,
              lineageToken: Reflect.get(message, "lineageToken") as string,
            }
          : {}),
      });
      adapterPorts.set(message.adapterId, port);
      if (rejectAdapterRegistrations) {
        port.postMessage({
          adapterId: message.adapterId,
          generation: message.generation,
          reason: "The adapter is already registered.",
          type: "cantrip-code-adapter-rejected-v2",
        });
        return;
      }
      port.postMessage({
        adapterId: message.adapterId,
        generation: message.generation,
        type: "cantrip-code-adapter-registered-v2",
      });
    },
  };
}
const fakeServiceWorker = fakeServiceWorkerEndpoint();
const fakeServiceWorkerContainer = Object.assign(new EventTarget(), {
  controller: fakeServiceWorker,
  register: vi.fn().mockResolvedValue({ active: fakeServiceWorker }),
  ready: Promise.resolve({ active: fakeServiceWorker }),
});

class FakeWebSocket extends EventTarget {
  static readonly CLOSED = 3;
  static readonly CLOSING = 2;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;

  readonly attachmentId: string;
  readonly protocols: string | string[] | undefined;
  readonly sent: Array<string | ArrayBuffer> = [];
  readonly url: string;
  binaryType = "blob";
  bufferedAmountReads = 0;
  #bufferedAmount = 0;
  readyState = FakeWebSocket.CONNECTING;

  get bufferedAmount(): number {
    this.bufferedAmountReads += 1;
    return this.#bufferedAmount;
  }

  set bufferedAmount(value: number) {
    this.#bufferedAmount = value;
  }

  constructor(url: string | URL, protocols?: string | string[]) {
    super();
    this.url = String(url);
    this.protocols = protocols;
    const segments = new URL(url).pathname.split("/");
    this.attachmentId = segments.at(-2) ?? "";
    sockets.push(this);
    if (!autoOpenSockets) return;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
    if (typeof data !== "string") return;
    const message = JSON.parse(data) as { type?: string };
    if (message.type !== "initialize") return;
    if (autoReadySockets) queueMicrotask(() => this.ready());
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  ready(): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "ready",
          attachmentId: this.attachmentId,
          tunnelId: attachmentTunnels.get(this.attachmentId),
          sourceEndpointId: "browser-source",
          destinationEndpointId:
            destinationEndpointIds[sockets.indexOf(this)] ??
            "worker-destination",
          expiresAt: "2026-08-24T00:00:00.000Z",
        }),
      }),
    );
  }

  terminalError(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("error"));
  }

  terminalClose(code = 1006, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    const event = new Event("close");
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
    });
    this.dispatchEvent(event);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function windowMessage(data: unknown, source: object): MessageEvent {
  let framedData = data;
  if (
    typeof data === "object" &&
    data !== null &&
    typeof Reflect.get(data, "type") === "string" &&
    (Reflect.get(data, "type") as string).startsWith(
      "cantrip-code-websocket-",
    ) &&
    typeof Reflect.get(data, "adapterId") === "string"
  ) {
    const adapterId = Reflect.get(data, "adapterId") as string;
    const registration = [...adapterRegistrationMessages]
      .reverse()
      .find((candidate) => candidate.adapterId === adapterId);
    framedData = {
      frameNonce: FRAME_NONCE,
      generation: registration?.generation,
      ...data,
    };
  }
  const event = new Event("message");
  Object.defineProperties(event, {
    data: { value: framedData },
    origin: { value: window.location.origin },
    source: { value: source },
  });
  return event as MessageEvent;
}

function serviceWorkerMessage(data: unknown, source: object): MessageEvent {
  const event = new Event("message");
  Object.defineProperties(event, {
    data: { value: data },
    source: { value: source },
  });
  return event as MessageEvent;
}

function binaryFrames(socket: FakeWebSocket) {
  return socket.sent
    .filter((value): value is ArrayBuffer => value instanceof ArrayBuffer)
    .map((value) => decodeTunnelDataPlaneFrame(new Uint8Array(value)));
}

function toBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function destinationHeader(
  source: TunnelDataPlaneFrameHeader,
  sequence: number,
): Omit<TunnelDataPlaneFrameHeader, "kind"> {
  return {
    protocolVersion: 1,
    tunnelId: source.tunnelId,
    attachmentId: source.attachmentId,
    sourceEndpointId: source.sourceEndpointId,
    destinationEndpointId: source.destinationEndpointId,
    connectionId: source.connectionId,
    sequence,
  };
}

function deliverControl(
  socket: FakeWebSocket,
  header: TunnelDataPlaneFrameHeader,
): void {
  socket.message(
    toBuffer(encodeTunnelDataPlaneFrame(header, new Uint8Array())),
  );
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function frameAad(
  header: Extract<TunnelDataPlaneFrameHeader, { kind: "data" }>,
): Uint8Array {
  const protection = header.protection!;
  return new TextEncoder().encode(
    JSON.stringify([
      header.protocolVersion,
      header.tunnelId,
      header.attachmentId,
      header.sourceEndpointId,
      header.destinationEndpointId,
      header.connectionId,
      header.sequence,
      "data",
      header.direction,
      protection.formatVersion,
      protection.algorithm,
      protection.keyRevision,
      protection.nonce,
    ]),
  );
}

async function protectedDestinationData(
  source: TunnelDataPlaneFrameHeader,
  sequence: number,
  payload: Uint8Array,
): Promise<{ header: TunnelDataPlaneFrameHeader; payload: Uint8Array }> {
  const nonce = new Uint8Array(12);
  nonce[11] = sequence;
  const header = {
    ...destinationHeader(source, sequence),
    kind: "data" as const,
    direction: "destination-to-source" as const,
    protection: {
      formatVersion: 1 as const,
      algorithm: "AES-256-GCM" as const,
      keyRevision: 1,
      nonce: encodeBase64Url(nonce),
    },
  };
  const key = await crypto.subtle.importKey(
    "raw",
    toBuffer(decodeBase64Url("A".repeat(43))),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toBuffer(nonce),
      additionalData: toBuffer(frameAad(header)),
    },
    key,
    toBuffer(payload),
  );
  return { header, payload: new Uint8Array(ciphertext) };
}

async function unprotectSourceData(
  header: Extract<TunnelDataPlaneFrameHeader, { kind: "data" }>,
  payload: Uint8Array,
): Promise<Uint8Array> {
  const nonce = decodeBase64Url(header.protection!.nonce);
  const key = await crypto.subtle.importKey(
    "raw",
    toBuffer(decodeBase64Url("A".repeat(43))),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toBuffer(nonce),
        additionalData: toBuffer(frameAad(header)),
      },
      key,
      toBuffer(payload),
    ),
  );
}

async function completeBrowserSocketHandshake(
  relay: FakeWebSocket,
  open: TunnelDataPlaneFrameHeader,
  trailingBytes = new Uint8Array(),
): Promise<void> {
  deliverControl(relay, {
    ...destinationHeader(open, 0),
    kind: "accepted",
    initialCreditBytes: 256 * 1_024,
  });
  await vi.waitFor(() => {
    expect(
      binaryFrames(relay).some(
        (frame) =>
          frame.header.connectionId === open.connectionId &&
          frame.header.kind === "data",
      ),
    ).toBe(true);
  });
  const handshakeFrame = binaryFrames(relay).find(
    (frame) =>
      frame.header.connectionId === open.connectionId &&
      frame.header.kind === "data",
  );
  if (!handshakeFrame || handshakeFrame.header.kind !== "data") {
    throw new Error("Browser WebSocket handshake frame was not sent.");
  }
  const handshake = new TextDecoder().decode(
    await unprotectSourceData(handshakeFrame.header, handshakeFrame.payload),
  );
  const key = /^Sec-WebSocket-Key:\s*(.+)\s*$/imu.exec(handshake)?.[1]?.trim();
  if (!key) throw new Error("Browser WebSocket handshake key was not sent.");
  const acceptBytes = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`),
  );
  let acceptBinary = "";
  for (const byte of new Uint8Array(acceptBytes)) {
    acceptBinary += String.fromCharCode(byte);
  }
  const responseHead = new TextEncoder().encode(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${btoa(acceptBinary)}\r\n\r\n`,
  );
  const response = new Uint8Array(
    responseHead.byteLength + trailingBytes.byteLength,
  );
  response.set(responseHead);
  response.set(trailingBytes, responseHead.byteLength);
  const protectedResponse = await protectedDestinationData(open, 1, response);
  relay.message(
    toBuffer(
      encodeTunnelDataPlaneFrame(
        protectedResponse.header,
        protectedResponse.payload,
      ),
    ),
  );
}

async function openBrowserSockets(
  relay: FakeWebSocket,
  attachment: { attachmentId: string; url: string },
  count: number,
): Promise<{
  opens: TunnelDataPlaneFrameHeader[];
  targets: Array<{ postMessage: ReturnType<typeof vi.fn> }>;
}> {
  const adapterId = attachmentAdapterId(attachment);
  const target = attachmentFrame(attachment);
  const targets = Array.from({ length: count }, () => target);
  for (const [index, target] of targets.entries()) {
    window.dispatchEvent(
      windowMessage(
        {
          adapterId,
          socketId: `aggregate-socket-${index}`,
          type: "cantrip-code-websocket-open-v1",
          url: `https://cantrip.example/__cantrip_code/${adapterId}/code/websocket`,
          protocols: [] as string[],
        },
        target,
      ),
    );
  }
  const opens = await waitForOpenFrames(relay, count);
  for (const [index, open] of opens.entries()) {
    await completeBrowserSocketHandshake(relay, open);
    await vi.waitFor(() => {
      expect(
        targets[index]!.postMessage.mock.calls.some(
          ([message]) =>
            Reflect.get(message, "event") === "open" &&
            Reflect.get(message, "socketId") === `aggregate-socket-${index}`,
        ),
      ).toBe(true);
    });
  }
  return { opens, targets };
}

function incompleteWebSocketMessage(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  bytes[0] = 0x82;
  bytes[1] = 0x7f;
  new DataView(bytes.buffer).setBigUint64(2, BigInt(8 * 1_024 * 1_024), false);
  return bytes;
}

async function deliverProtectedSocketBytes(
  relay: FakeWebSocket,
  open: TunnelDataPlaneFrameHeader,
  bytes: Uint8Array,
  waitUntilConsumed: boolean,
): Promise<void> {
  const existingCredits = binaryFrames(relay).filter(
    (frame) =>
      frame.header.connectionId === open.connectionId &&
      frame.header.kind === "credit" &&
      frame.header.direction === "destination-to-source",
  ).length;
  let sequence = 2;
  let chunks = 0;
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += TUNNEL_DATA_PLANE_MAX_PLAINTEXT_BYTES
  ) {
    const chunk = bytes.subarray(
      offset,
      offset + TUNNEL_DATA_PLANE_MAX_PLAINTEXT_BYTES,
    );
    const protectedChunk = await protectedDestinationData(
      open,
      sequence++,
      chunk,
    );
    relay.message(
      toBuffer(
        encodeTunnelDataPlaneFrame(
          protectedChunk.header,
          protectedChunk.payload,
        ),
      ),
    );
    chunks += 1;
  }
  if (!waitUntilConsumed) return;
  await vi.waitFor(
    () => {
      expect(
        binaryFrames(relay).filter(
          (frame) =>
            frame.header.connectionId === open.connectionId &&
            frame.header.kind === "credit" &&
            frame.header.direction === "destination-to-source",
        ),
      ).toHaveLength(existingCredits + chunks);
    },
    { timeout: 5_000 },
  );
}

function wire(): CodeProtectedAttachmentWire {
  return {
    attachmentId: TUNNEL_ID,
    tunnelId: TUNNEL_ID,
    sessionId: "22222222-2222-4222-8222-222222222222",
    expiresAt: "2026-08-24T00:00:00.000Z",
    runtime: {
      sessionId: "22222222-2222-4222-8222-222222222222",
      workspaceUri: "file:///worker/project.code-workspace",
      status: "running",
      editorBuild: {
        version: "1.109.5",
        upstreamRevision: "revision",
        patchset: 8,
        fingerprint: "fingerprint",
      },
      processInstanceId: "process-1",
      bridgeConnected: true,
      dirtyEditors: [],
      workbench: {
        activeEditor: null,
        git: null,
        conflicts: [],
        savePolicy: "always",
        agentStatus: "idle",
      },
      startedAt: "2026-08-23T00:00:00.000Z",
      lastActivityAt: "2026-08-23T00:00:00.000Z",
      lastError: null,
    },
  };
}

const sharedOwnedAttachments: BoundExplorerCodeSessionAttachment[] = [];

function sharedOwned(index: number): BoundExplorerCodeSessionAttachment {
  const suffix = String(index).padStart(12, "0");
  const owned: BoundExplorerCodeSessionAttachment = {
    attachment: {
      formatVersion: 2,
      transport: {
        formatVersion: 2,
        transportId: TUNNEL_ID,
        tunnelId: TUNNEL_ID,
        workerId: "worker-1",
        securityScopeId: "33333333-3333-4333-8333-333333333333",
        serverId: "server-1",
        serverControlPlaneGeneration: "44444444-4444-4444-8444-444444444444",
        protectedKeyRevision: 1,
        workerProcessGeneration: "55555555-5555-4555-8555-555555555555",
        expiresAt: "2026-08-24T00:00:00.000Z",
      },
      session: {
        formatVersion: 2,
        attachmentId: `60000000-0000-4000-8000-${suffix}`,
        transportId: TUNNEL_ID,
        sessionId: `70000000-0000-4000-8000-${suffix}`,
        routeGrant: `${"A".repeat(42)}${["A", "E", "I", "M"][index]}`,
        expiresAt: "2026-08-24T00:00:00.000Z",
        runtime: {
          ...wire().runtime,
          sessionId: `70000000-0000-4000-8000-${suffix}`,
        },
      },
    },
    binding: {
      identity: {
        accountId: "account-1",
        connectionId: "server-1",
        generation: 1,
        incarnationId: "88888888-8888-4888-8888-888888888888",
        serverId: "server-1",
        serverUrl: "https://cantrip.example",
        userId: "owner-1",
      },
      serverUrl: "https://cantrip.example",
    },
  };
  sharedOwnedAttachments.push(owned);
  return owned;
}

function httpRequest(requestId: string, adapterId = TUNNEL_ID) {
  return {
    adapterId,
    body: null,
    headers: [] as Array<[string, string]>,
    method: "GET",
    requestId,
    type: "cantrip-code-http-request-v1" as const,
    url: `https://cantrip.example/__cantrip_code/${adapterId}/code/`,
  };
}

function attachmentAdapterId(attachment: { url: string }): string {
  const match = /^\/__cantrip_code\/([^/]+)\/code(?:\/|$)/u.exec(
    new URL(attachment.url).pathname,
  );
  if (!match?.[1]) throw new Error("Browser attachment adapter was missing.");
  return match[1];
}

async function adapterFingerprint(adapterId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(adapterId.toLowerCase()),
    ),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function attachmentFrame(attachment: { attachmentId: string; url: string }) {
  const target = { postMessage: vi.fn() };
  bindBrowserCodeAttachmentFrame(
    attachment.attachmentId,
    target as unknown as WindowProxy,
    FRAME_NONCE,
  );
  return target;
}

function httpChannel(adapterId?: string): FakeMessagePort {
  const channel = adapterId
    ? adapterPorts.get(adapterId)
    : [...adapterPorts.values()].at(-1);
  if (!channel)
    throw new Error("Browser Code HTTP adapter was not registered.");
  return channel;
}

async function waitForOpenFrames(
  socket: FakeWebSocket,
  count: number,
): Promise<TunnelDataPlaneFrameHeader[]> {
  await vi.waitFor(() => {
    expect(
      binaryFrames(socket).filter((frame) => frame.header.kind === "open"),
    ).toHaveLength(count);
  });
  return binaryFrames(socket)
    .filter((frame) => frame.header.kind === "open")
    .map((frame) => frame.header);
}

async function acceptConnection(
  socket: FakeWebSocket,
  open: TunnelDataPlaneFrameHeader,
): Promise<void> {
  deliverControl(socket, {
    ...destinationHeader(open, 0),
    kind: "accepted",
    initialCreditBytes: 256 * 1_024,
  });
  await vi.waitFor(() => {
    expect(
      binaryFrames(socket).some(
        (frame) =>
          frame.header.connectionId === open.connectionId &&
          frame.header.kind === "data",
      ),
    ).toBe(true);
  });
}

function responseFor(channel: { messages: unknown[] }, requestId: string) {
  return channel.messages.find(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      Reflect.get(message, "requestId") === requestId,
  ) as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  attachmentTunnels.clear();
  sockets.length = 0;
  destinationEndpointIds.length = 0;
  attachmentSequence = 0;
  autoOpenSockets = true;
  autoReadySockets = true;
  rejectAdapterRegistrations = false;
  fakeServiceWorkerContainer.controller = fakeServiceWorker;
  fakeServiceWorkerContainer.ready = Promise.resolve({
    active: fakeServiceWorker,
  });
  fakeServiceWorkerContainer.register
    .mockReset()
    .mockResolvedValue({ active: fakeServiceWorker });
  adapterPorts.clear();
  adapterRegistrationMessages.length = 0;

  mocks.getActiveServerUrl.mockReturnValue("https://cantrip.example");
  mocks.explorerCodeSessionBindingCurrent.mockReturnValue(true);
  mocks.getActiveServerConnection.mockReturnValue({
    accountId: "account-1",
    id: "server-1",
    kind: "remote",
    name: "Cantrip",
    url: "https://cantrip.example",
  });
  mocks.getClientSession.mockReturnValue({
    authMode: "session",
    csrfToken: "c".repeat(32),
    expiresAt: "2026-08-24T00:00:00.000Z",
    serverId: "server-1",
    user: { id: "owner-1" },
  });
  mocks.getTunnelTransportConfiguration.mockResolvedValue({
    dataProtection: {
      formatVersion: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      key: "A".repeat(43),
    },
    workerId: "worker-1",
  });
  mocks.createTunnelAttachment.mockImplementation(async (tunnelId: string) => {
    const attachmentId = `browser-attachment-${++attachmentSequence}`;
    attachmentTunnels.set(attachmentId, tunnelId);
    return {
      attachmentId,
      tunnelId,
      secret: "s".repeat(32),
      connectPath: `/api/tunnel-attachments/${attachmentId}/connect`,
      secretExpiresAt: "2026-08-24T00:00:00.000Z",
      expiresAt: "2026-08-24T00:00:00.000Z",
    };
  });
  mocks.deleteTunnelAttachment.mockResolvedValue(undefined);

  const browserWindow = new EventTarget() as EventTarget & {
    location: { origin: string };
  };
  browserWindow.location = { origin: "https://cantrip.example" };
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("MessageChannel", FakeMessageChannel);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("navigator", {
    serviceWorker: fakeServiceWorkerContainer,
  });
});

afterEach(async () => {
  await Promise.all(
    sharedOwnedAttachments
      .splice(0)
      .map((owned) => stopSharedBrowserCodeAttachment(owned)),
  );
  await stopBrowserCodeAttachment(TUNNEL_ID);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shared browser Code transport pooling", () => {
  it("retains the browser transport registry across HMR state reuse", () => {
    const hotState = {};
    const first = browserCodeTunnelRuntime(hotState);

    expect(browserCodeTunnelRuntime(hotState)).toBe(first);
  });

  it("updates an old service-worker controller without replacing the relay", async () => {
    const oldWorker = fakeServiceWorkerEndpoint(false);
    const replacement = fakeServiceWorkerEndpoint();
    fakeServiceWorkerContainer.controller = oldWorker;
    fakeServiceWorkerContainer.ready = Promise.resolve({ active: oldWorker });
    fakeServiceWorkerContainer.register.mockImplementation(async () => {
      queueMicrotask(() => {
        fakeServiceWorkerContainer.controller = replacement;
        fakeServiceWorkerContainer.ready = Promise.resolve({
          active: replacement,
        });
        fakeServiceWorkerContainer.dispatchEvent(new Event("controllerchange"));
      });
      return {
        active: oldWorker,
        update: vi.fn().mockResolvedValue(undefined),
      };
    });

    const owned = sharedOwned(0);
    const opened = await startSharedBrowserCodeAttachment(owned);

    expect(fakeServiceWorkerContainer.register).toHaveBeenCalledOnce();
    expect(mocks.createTunnelAttachment).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(1);
    expect(adapterPorts).toHaveLength(1);
    expect(sharedBrowserCodeAttachmentHealthy(owned, opened.leaseId)).toBe(
      true,
    );

    await stopSharedBrowserCodeAttachment(owned, opened.leaseId);
  });

  it("waits for the compatible worker to control the page before registering adapters", async () => {
    vi.useFakeTimers();
    const oldWorker = fakeServiceWorkerEndpoint(false);
    const replacement = fakeServiceWorkerEndpoint();
    fakeServiceWorkerContainer.controller = oldWorker;
    fakeServiceWorkerContainer.ready = Promise.resolve({
      active: replacement,
    });
    fakeServiceWorkerContainer.register.mockResolvedValue({
      active: replacement,
      update: vi.fn().mockResolvedValue(undefined),
    });

    const owned = sharedOwned(0);
    const opening = startSharedBrowserCodeAttachment(owned);
    await vi.advanceTimersByTimeAsync(250);
    expect(adapterRegistrationMessages).toHaveLength(0);

    fakeServiceWorkerContainer.controller = replacement;
    fakeServiceWorkerContainer.dispatchEvent(new Event("controllerchange"));
    await vi.advanceTimersByTimeAsync(50);
    const opened = await opening;

    expect(adapterRegistrationMessages).toHaveLength(1);
    expect(adapterPorts).toHaveLength(1);
    await stopSharedBrowserCodeAttachment(owned, opened.leaseId);
  });

  it("uses one relay attachment and outer socket for four logical sessions", async () => {
    const owners = [0, 1, 2, 3].map(sharedOwned);
    const opened = await Promise.all(
      owners.map((owned) => startSharedBrowserCodeAttachment(owned)),
    );

    expect(mocks.getTunnelTransportConfiguration).toHaveBeenCalledOnce();
    expect(mocks.createTunnelAttachment).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(1);
    expect(adapterPorts).toHaveLength(4);
    const rootLeases = new Set<string>();
    for (const [index, candidate] of opened.entries()) {
      expect(candidate.attachment.attachmentId).toBe(
        owners[index]!.attachment.session.attachmentId,
      );
      expect(candidate.attachment.url).toContain("/__cantrip_code/");
      expect(candidate.attachment.url).not.toContain(
        owners[index]!.attachment.session.routeGrant,
      );
      const rootLease = new URL(candidate.attachment.url).searchParams.get(
        "cantripRootLease",
      );
      expect(rootLease).toMatch(/^[A-Za-z0-9_-]{16,128}$/u);
      rootLeases.add(rootLease!);
    }
    expect(rootLeases.size).toBe(4);

    await stopSharedBrowserCodeAttachment(owners[0]!, opened[0]!.leaseId);
    expect(mocks.deleteTunnelAttachment).not.toHaveBeenCalled();
    expect(sockets[0]!.readyState).toBe(FakeWebSocket.OPEN);

    await Promise.all(
      owners
        .slice(1)
        .map((owned, index) =>
          stopSharedBrowserCodeAttachment(owned, opened[index + 1]!.leaseId),
        ),
    );
    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledOnce();
    expect(sockets[0]!.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("keeps the exact pool key fenced until final relay cleanup completes", async () => {
    const first = sharedOwned(0);
    const firstOpened = await startSharedBrowserCodeAttachment(first);
    const cleanup = deferred<void>();
    mocks.deleteTunnelAttachment.mockImplementationOnce(
      async () => cleanup.promise,
    );

    const closing = stopSharedBrowserCodeAttachment(first, firstOpened.leaseId);
    await vi.waitFor(() => {
      expect(mocks.deleteTunnelAttachment).toHaveBeenCalledOnce();
    });
    expect(sockets[0]!.readyState).toBe(FakeWebSocket.CLOSED);

    const replacement = sharedOwned(1);
    const reopening = startSharedBrowserCodeAttachment(replacement);
    await Promise.resolve();
    expect(mocks.createTunnelAttachment).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(1);

    cleanup.resolve();
    await closing;
    const replacementOpened = await reopening;
    expect(mocks.createTunnelAttachment).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.readyState).toBe(FakeWebSocket.OPEN);

    await stopSharedBrowserCodeAttachment(first, firstOpened.leaseId);
    expect(sockets[1]!.readyState).toBe(FakeWebSocket.OPEN);
    await stopSharedBrowserCodeAttachment(
      replacement,
      replacementOpened.leaseId,
    );
  });

  it("owns an allocated relay before a post-allocation identity rejection", async () => {
    let bindingCurrent = true;
    mocks.explorerCodeSessionBindingCurrent.mockImplementation(
      () => bindingCurrent,
    );
    mocks.createTunnelAttachment.mockImplementationOnce(async (tunnelId) => {
      const attachmentId = `browser-attachment-${++attachmentSequence}`;
      attachmentTunnels.set(attachmentId, tunnelId);
      bindingCurrent = false;
      return {
        attachmentId,
        tunnelId,
        secret: "s".repeat(32),
        connectPath: `/api/tunnel-attachments/${attachmentId}/connect`,
        secretExpiresAt: "2026-08-24T00:00:00.000Z",
        expiresAt: "2026-08-24T00:00:00.000Z",
      };
    });

    await expect(
      startSharedBrowserCodeAttachment(sharedOwned(0)),
    ).rejects.toThrow(/identity changed/iu);

    expect(sockets).toHaveLength(0);
    expect(mocks.deleteTunnelAttachment).not.toHaveBeenCalled();

    bindingCurrent = true;
    const replacement = sharedOwned(1);
    const opened = await startSharedBrowserCodeAttachment(replacement);
    expect(mocks.createTunnelAttachment).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);
    await stopSharedBrowserCodeAttachment(replacement, opened.leaseId);
  });

  it("does not share a browser relay across worker process generations", async () => {
    const first = sharedOwned(0);
    const second = sharedOwned(1);
    second.attachment.transport.workerProcessGeneration =
      "99999999-9999-4999-8999-999999999999";

    const [firstOpened, secondOpened] = await Promise.all([
      startSharedBrowserCodeAttachment(first),
      startSharedBrowserCodeAttachment(second),
    ]);

    expect(mocks.createTunnelAttachment).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);

    await Promise.all([
      stopSharedBrowserCodeAttachment(first, firstOpened.leaseId),
      stopSharedBrowserCodeAttachment(second, secondOpened.leaseId),
    ]);
  });

  it("separates every browser pool security-identity field", async () => {
    const baseline = sharedOwned(0);
    const baselineOpened = await startSharedBrowserCodeAttachment(baseline);
    const mutations: Array<
      readonly [
        string,
        (owned: BoundExplorerCodeSessionAttachment, index: number) => void,
      ]
    > = [
      [
        "account",
        (owned, index) => {
          owned.binding.identity.accountId = `changed-account-${index}`;
        },
      ],
      [
        "connection",
        (owned, index) => {
          owned.binding.identity.connectionId = `connection-${index}`;
        },
      ],
      [
        "client generation",
        (owned, index) => {
          owned.binding.identity.generation += index;
        },
      ],
      [
        "client incarnation",
        (owned, index) => {
          owned.binding.identity.incarnationId = `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        },
      ],
      [
        "client server",
        (owned, index) => {
          owned.binding.identity.serverId = `server-${index}`;
        },
      ],
      [
        "client server URL",
        (owned, index) => {
          owned.binding.identity.serverUrl = `https://identity-${index}.example`;
        },
      ],
      [
        "user",
        (owned, index) => {
          owned.binding.identity.userId = `owner-${index}`;
        },
      ],
      [
        "bound server URL",
        (owned, index) => {
          owned.binding.serverUrl = `https://binding-${index}.example`;
        },
      ],
      [
        "worker",
        (owned, index) => {
          owned.attachment.transport.workerId = `worker-${index}`;
        },
      ],
      [
        "security scope",
        (owned, index) => {
          owned.attachment.transport.securityScopeId = `91000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        },
      ],
      [
        "transport server",
        (owned, index) => {
          owned.attachment.transport.serverId = `transport-server-${index}`;
        },
      ],
      [
        "server control plane",
        (owned, index) => {
          owned.attachment.transport.serverControlPlaneGeneration = `92000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        },
      ],
    ];

    for (const [offset, [field, mutate]] of mutations.entries()) {
      const index = offset + 1;
      const owned = sharedOwned((offset % 3) + 1);
      mutate(owned, index);
      mocks.getTunnelTransportConfiguration.mockResolvedValue({
        dataProtection: {
          formatVersion: 1,
          algorithm: "AES-256-GCM",
          keyRevision: owned.attachment.transport.protectedKeyRevision,
          key: "A".repeat(43),
        },
        workerId: owned.attachment.transport.workerId,
      });
      const candidate = await startSharedBrowserCodeAttachment(owned);
      expect(mocks.createTunnelAttachment, field).toHaveBeenCalledTimes(
        index + 1,
      );
      await stopSharedBrowserCodeAttachment(owned, candidate.leaseId);
    }

    expect(mocks.createTunnelAttachment).toHaveBeenCalledTimes(
      mutations.length + 1,
    );
    expect(sockets).toHaveLength(mutations.length + 1);

    await stopSharedBrowserCodeAttachment(baseline, baselineOpened.leaseId);
  });

  it("separates protected-key revisions in the browser pool", async () => {
    const first = sharedOwned(0);
    const firstOpened = await startSharedBrowserCodeAttachment(first);

    const second = sharedOwned(1);
    second.attachment.transport.protectedKeyRevision = 2;
    mocks.getTunnelTransportConfiguration.mockResolvedValue({
      dataProtection: {
        formatVersion: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 2,
        key: "B".repeat(43),
      },
      workerId: "worker-1",
    });
    const secondOpened = await startSharedBrowserCodeAttachment(second);

    expect(mocks.createTunnelAttachment).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);

    await Promise.all([
      stopSharedBrowserCodeAttachment(first, firstOpened.leaseId),
      stopSharedBrowserCodeAttachment(second, secondOpened.leaseId),
    ]);
  });

  it("retires the exact pool generation on authentication identity rotation", async () => {
    const first = sharedOwned(0);
    const second = sharedOwned(1);
    await Promise.all([
      startSharedBrowserCodeAttachment(first),
      startSharedBrowserCodeAttachment(second),
    ]);
    expect(mocks.createTunnelAttachment).toHaveBeenCalledOnce();

    mocks.explorerCodeSessionBindingCurrent.mockReturnValue(false);
    for (const listener of mocks.clientIdentityListeners) listener();

    await vi.waitFor(() => {
      expect(sockets[0]!.readyState).toBe(FakeWebSocket.CLOSED);
    });
    expect(mocks.deleteTunnelAttachment).not.toHaveBeenCalled();

    mocks.explorerCodeSessionBindingCurrent.mockReturnValue(true);
    const replacement = sharedOwned(2);
    const opened = await startSharedBrowserCodeAttachment(replacement);
    expect(mocks.createTunnelAttachment).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    await stopSharedBrowserCodeAttachment(replacement, opened.leaseId);
  });

  it("re-registers a logical adapter after service-worker state restarts", async () => {
    const owned = sharedOwned(0);
    const opened = await startSharedBrowserCodeAttachment(owned);
    const adapterId = attachmentAdapterId(opened.attachment);
    const fingerprint = await adapterFingerprint(adapterId);
    const originalPort = adapterPorts.get(adapterId);
    expect(originalPort).toBeDefined();

    fakeServiceWorkerContainer.dispatchEvent(
      serviceWorkerMessage(
        {
          adapterFingerprint: fingerprint,
          type: "cantrip-code-adapter-registration-required-v2",
        },
        fakeServiceWorker,
      ),
    );
    await vi.waitFor(() => {
      expect(adapterPorts.get(adapterId)).not.toBe(originalPort);
    });

    expect(mocks.createTunnelAttachment).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(1);
    const recoveredPort = adapterPorts.get(adapterId)!;
    recoveredPort.receive(httpRequest("after-worker-restart", adapterId));
    await waitForOpenFrames(sockets[0]!, 1);

    await stopSharedBrowserCodeAttachment(owned, opened.leaseId);
  });

  it("proactively restores every live adapter when a new service worker takes control", async () => {
    const owned = sharedOwned(0);
    const opened = await startSharedBrowserCodeAttachment(owned);
    const adapterId = attachmentAdapterId(opened.attachment);
    const original = adapterRegistrationMessages.at(-1)!;
    const originalPort = adapterPorts.get(adapterId);
    const frame = attachmentFrame(opened.attachment);
    window.dispatchEvent(
      windowMessage(
        {
          adapterId,
          frameNonce: FRAME_NONCE,
          generation: original.generation,
          lineageToken: "99999999-9999-4999-8999-999999999999",
          type: "cantrip-code-worker-lineage-v2",
        },
        frame,
      ),
    );

    const replacement = fakeServiceWorkerEndpoint();
    fakeServiceWorkerContainer.controller = replacement;
    fakeServiceWorkerContainer.ready = Promise.resolve({
      active: replacement,
    });
    fakeServiceWorkerContainer.dispatchEvent(new Event("controllerchange"));

    await vi.waitFor(() => {
      expect(adapterPorts.get(adapterId)).not.toBe(originalPort);
    });
    expect(adapterRegistrationMessages.at(-1)).toMatchObject({
      adapterId,
      frameNonce: FRAME_NONCE,
      generation: original.generation,
      lineageToken: "99999999-9999-4999-8999-999999999999",
      rootLease: original.rootLease,
    });
    expect(mocks.createTunnelAttachment).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(1);
    expect(sharedBrowserCodeAttachmentHealthy(owned, opened.leaseId)).toBe(
      true,
    );

    await stopSharedBrowserCodeAttachment(owned, opened.leaseId);
  });

  it("ignores stale recovery sources and keeps failed recovery retryable", async () => {
    const owned = sharedOwned(0);
    const opened = await startSharedBrowserCodeAttachment(owned);
    const adapterId = attachmentAdapterId(opened.attachment);
    const fingerprint = await adapterFingerprint(adapterId);
    const originalPort = adapterPorts.get(adapterId);

    fakeServiceWorkerContainer.dispatchEvent(
      serviceWorkerMessage(
        {
          adapterFingerprint: fingerprint,
          type: "cantrip-code-adapter-registration-required-v2",
        },
        {},
      ),
    );
    await Promise.resolve();
    expect(adapterPorts.get(adapterId)).toBe(originalPort);

    rejectAdapterRegistrations = true;
    fakeServiceWorkerContainer.dispatchEvent(
      serviceWorkerMessage(
        {
          adapterFingerprint: fingerprint,
          type: "cantrip-code-adapter-registration-required-v2",
        },
        fakeServiceWorker,
      ),
    );
    await vi.waitFor(() => {
      expect(adapterPorts.get(adapterId)).not.toBe(originalPort);
    });
    expect(sharedBrowserCodeAttachmentHealthy(owned, opened.leaseId)).toBe(
      true,
    );
    expect(sockets[0]!.readyState).toBe(FakeWebSocket.OPEN);

    const rejectedPort = adapterPorts.get(adapterId);
    rejectAdapterRegistrations = false;
    fakeServiceWorkerContainer.dispatchEvent(
      serviceWorkerMessage(
        {
          adapterFingerprint: fingerprint,
          type: "cantrip-code-adapter-registration-required-v2",
        },
        fakeServiceWorker,
      ),
    );
    await vi.waitFor(() => {
      expect(adapterPorts.get(adapterId)).not.toBe(rejectedPort);
    });
    expect(sharedBrowserCodeAttachmentHealthy(owned, opened.leaseId)).toBe(
      true,
    );
    expect(mocks.createTunnelAttachment).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(1);

    await stopSharedBrowserCodeAttachment(owned, opened.leaseId);
  });

  it("ignores malformed and nonmatching adapter fingerprints", async () => {
    const owned = sharedOwned(0);
    const opened = await startSharedBrowserCodeAttachment(owned);
    const adapterId = attachmentAdapterId(opened.attachment);
    const originalPort = adapterPorts.get(adapterId);
    const digest = vi.spyOn(crypto.subtle, "digest");

    fakeServiceWorkerContainer.dispatchEvent(
      serviceWorkerMessage(
        {
          adapterFingerprint: adapterId,
          type: "cantrip-code-adapter-registration-required-v2",
        },
        fakeServiceWorker,
      ),
    );
    await Promise.resolve();
    expect(digest).not.toHaveBeenCalled();

    fakeServiceWorkerContainer.dispatchEvent(
      serviceWorkerMessage(
        {
          adapterFingerprint: "A".repeat(43),
          type: "cantrip-code-adapter-registration-required-v2",
        },
        fakeServiceWorker,
      ),
    );
    await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce());
    expect(adapterPorts.get(adapterId)).toBe(originalPort);

    digest.mockRestore();
    await stopSharedBrowserCodeAttachment(owned, opened.leaseId);
  });

  it("does not recover a session removed during fingerprint lookup", async () => {
    const owned = sharedOwned(0);
    const opened = await startSharedBrowserCodeAttachment(owned);
    const adapterId = attachmentAdapterId(opened.attachment);
    const fingerprint = await adapterFingerprint(adapterId);
    const originalPort = adapterPorts.get(adapterId);
    const digestResult = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(adapterId.toLowerCase()),
    );
    const pendingDigest = deferred<ArrayBuffer>();
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementationOnce(async () => pendingDigest.promise);

    fakeServiceWorkerContainer.dispatchEvent(
      serviceWorkerMessage(
        {
          adapterFingerprint: fingerprint,
          type: "cantrip-code-adapter-registration-required-v2",
        },
        fakeServiceWorker,
      ),
    );
    await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce());
    await stopSharedBrowserCodeAttachment(owned, opened.leaseId);
    pendingDigest.resolve(digestResult);
    await Promise.resolve();
    await Promise.resolve();

    expect(adapterPorts.get(adapterId)).toBe(originalPort);
    expect(mocks.createTunnelAttachment).toHaveBeenCalledOnce();
    digest.mockRestore();
  });
});

describe("browser Code attachment terminal state", () => {
  it("keeps the request stream open until the proxied HTTP response closes", async () => {
    const response = new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\neditor-ready",
    );
    let receive: ((chunk: Uint8Array) => void) | undefined;
    const connection = {
      close: vi.fn(),
      halfClose: vi.fn(),
      onData: vi.fn((listener: (chunk: Uint8Array) => void) => {
        receive = listener;
      }),
      send: vi.fn().mockResolvedValue(undefined),
      waitClosed: vi.fn(async () => {
        receive?.(response);
      }),
    };
    const tunnel = {
      openConnection: vi.fn().mockResolvedValue(connection),
    };

    const result = await proxyBrowserCodeHttp(tunnel as never, {
      adapterId: "33333333-3333-4333-8333-333333333333",
      body: null,
      headers: [],
      method: "GET",
      requestId: "request-1",
      type: "cantrip-code-http-request-v1",
      url: "https://cantrip.example/__cantrip_code/33333333-3333-4333-8333-333333333333/code/?cantripFrameNonce=frame_nonce_123456&cantripRootLease=root_lease_123456",
    });

    expect(connection.send).toHaveBeenCalledOnce();
    const requestBytes = connection.send.mock.calls[0]![0];
    const requestText = new TextDecoder().decode(requestBytes);
    expect(requestText).toContain("cantripFrameNonce=frame_nonce_123456");
    expect(requestText).not.toContain("cantripRootLease");
    expect(requestText).not.toContain("root_lease_123456");
    expect(connection.halfClose).not.toHaveBeenCalled();
    expect(connection.waitClosed).toHaveBeenCalledOnce();
    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toBe("editor-ready");
  });

  it("bounds the outer relay WebSocket connect wait", async () => {
    vi.useFakeTimers();
    autoOpenSockets = false;
    autoReadySockets = false;
    const connect = startBrowserCodeAttachment(wire()).then(
      () => null,
      (error: unknown) => error,
    );
    let connectSettled = false;
    void connect.then(() => {
      connectSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    const connectWasBounded = connectSettled;
    sockets[0]!.open();
    sockets[0]!.ready();
    await connect;

    expect(connectWasBounded).toBe(true);
  });

  it("bounds the relay JSON-ready wait after WebSocket open", async () => {
    vi.useFakeTimers();
    autoOpenSockets = true;
    autoReadySockets = false;
    const ready = startBrowserCodeAttachment(wire()).then(
      () => null,
      (error: unknown) => error,
    );
    let readySettled = false;
    void ready.then(() => {
      readySettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    const readyWasBounded = readySettled;
    sockets[0]!.ready();
    await ready;

    expect(readyWasBounded).toBe(true);
  });

  it("bounds a logical stream waiting for the destination to accept open", async () => {
    vi.useFakeTimers();
    const gate = deferred<{
      close(): void;
      halfClose(): void;
      onData(listener: (chunk: Uint8Array) => void): void;
      send(payload: Uint8Array): Promise<void>;
      waitClosed(): Promise<void>;
    }>();
    const response = new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
    );
    const connection = {
      close: vi.fn(),
      halfClose: vi.fn(),
      onData: vi.fn((listener: (chunk: Uint8Array) => void) =>
        listener(response),
      ),
      send: vi.fn().mockResolvedValue(undefined),
      waitClosed: vi.fn().mockResolvedValue(undefined),
    };
    const pending = proxyBrowserCodeHttp(
      { openConnection: vi.fn(() => gate.promise) } as never,
      httpRequest("bounded-open"),
    ).then(
      (result) => result,
      (error: unknown) => error,
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(60_000);
    const wasBounded = settled;
    gate.resolve(connection);
    await pending;

    expect(wasBounded).toBe(true);
  });

  it("reconnects a transient relay close without replacing the retained session or generic attachment", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
    const unavailable = vi.fn();
    const unsubscribe = subscribeBrowserCodeAttachmentUnavailable(unavailable);
    await startBrowserCodeAttachment(wire());
    await vi.advanceTimersByTimeAsync(0);
    const firstSocket = sockets[0]!;
    const firstProtocol = firstSocket.protocols;

    firstSocket.terminalClose(1006, "transient network loss");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.attachmentId).toBe(firstSocket.attachmentId);
    expect(sockets[1]!.protocols).toBe(firstProtocol);
    expect(mocks.createTunnelAttachment).toHaveBeenCalledOnce();
    expect(unavailable).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("rotates an expired relay credential while preserving the original client identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
    mocks.createTunnelAttachment.mockImplementation(
      async (tunnelId: string) => {
        const attachmentId = `browser-attachment-${++attachmentSequence}`;
        attachmentTunnels.set(attachmentId, tunnelId);
        return {
          attachmentId,
          tunnelId,
          secret: "s".repeat(32),
          connectPath: `/api/tunnel-attachments/${attachmentId}/connect`,
          secretExpiresAt: "2026-08-23T00:00:01.000Z",
          expiresAt: "2026-08-24T00:00:00.000Z",
        };
      },
    );
    await startBrowserCodeAttachment(wire());
    const firstClientId = mocks.createTunnelAttachment.mock.calls[0]![1];

    await vi.advanceTimersByTimeAsync(1_001);
    sockets[0]!.terminalClose(1006, "transient network loss");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
    expect(mocks.createTunnelAttachment).toHaveBeenCalledTimes(2);
    expect(mocks.createTunnelAttachment.mock.calls[1]![1]).toEqual(
      firstClientId,
    );
    expect(sockets[1]!.attachmentId).toBe("browser-attachment-2");
  });

  it("retires a retained browser workbench when credential rotation changes its destination worker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
    destinationEndpointIds.push("worker:original", "worker:replacement");
    mocks.createTunnelAttachment.mockImplementation(
      async (tunnelId: string) => {
        const attachmentId = `browser-attachment-${++attachmentSequence}`;
        attachmentTunnels.set(attachmentId, tunnelId);
        return {
          attachmentId,
          tunnelId,
          secret: "s".repeat(32),
          connectPath: `/api/tunnel-attachments/${attachmentId}/connect`,
          secretExpiresAt: "2026-08-23T00:00:01.000Z",
          expiresAt: "2026-08-24T00:00:00.000Z",
        };
      },
    );
    const unavailable = vi.fn();
    const unsubscribe = subscribeBrowserCodeAttachmentUnavailable(unavailable);
    await startBrowserCodeAttachment(wire());

    await vi.advanceTimersByTimeAsync(1_001);
    sockets[0]!.terminalClose(1006, "transient network loss");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sockets).toHaveLength(2);
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(false);
    expect(unavailable).toHaveBeenCalledOnce();
    expect(unavailable.mock.calls[0]![0]).toMatchObject({
      tunnelId: TUNNEL_ID,
      reason: expect.stringMatching(/endpoint identity changed/iu),
    });
    unsubscribe();
  });

  it("classifies a delayed 1008 close after error before reconnecting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
    await startBrowserCodeAttachment(wire());
    const firstClientId = mocks.createTunnelAttachment.mock.calls[0]![1];

    sockets[0]!.terminalError();
    await vi.advanceTimersByTimeAsync(1);
    sockets[0]!.terminalClose(1008, "credential rejected");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
    expect(mocks.createTunnelAttachment).toHaveBeenCalledTimes(2);
    expect(mocks.createTunnelAttachment.mock.calls[1]![1]).toEqual(
      firstClientId,
    );
    expect(sockets[1]!.attachmentId).toBe("browser-attachment-2");
  });

  it.each([401, 403, 404, 409])(
    "treats an attachment HTTP %i as terminal instead of retrying",
    async (status) => {
      vi.useFakeTimers();
      mocks.createTunnelAttachment.mockRejectedValueOnce(
        Object.assign(new Error(`Attachment rejected with HTTP ${status}.`), {
          status,
        }),
      );

      await expect(startBrowserCodeAttachment(wire())).rejects.toThrow(
        `HTTP ${status}`,
      );
      await vi.advanceTimersByTimeAsync(30_000);

      expect(mocks.createTunnelAttachment).toHaveBeenCalledOnce();
      expect(sockets).toHaveLength(0);
      expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(false);
    },
  );

  it("does not reconnect a retained relay through a changed server identity", async () => {
    vi.useFakeTimers();
    const unavailable = vi.fn();
    const unsubscribe = subscribeBrowserCodeAttachmentUnavailable(unavailable);
    await startBrowserCodeAttachment(wire());

    mocks.getActiveServerUrl.mockReturnValue("https://other-account.example");
    sockets[0]!.terminalClose(1006, "transient network loss");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sockets).toHaveLength(1);
    expect(mocks.createTunnelAttachment).toHaveBeenCalledOnce();
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(false);
    expect(unavailable).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("answers a destination half-close with close and releases that logical stream", async () => {
    const attachment = await startBrowserCodeAttachment(wire());
    const adapterId = attachmentAdapterId(attachment);
    const socket = sockets[0]!;
    const channel = httpChannel();
    channel.receive(httpRequest("half-close", adapterId));
    const [open] = await waitForOpenFrames(socket, 1);
    await acceptConnection(socket, open!);

    const response = await protectedDestinationData(
      open!,
      1,
      new TextEncoder().encode(
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
      ),
    );
    socket.message(
      toBuffer(encodeTunnelDataPlaneFrame(response.header, response.payload)),
    );
    deliverControl(socket, {
      ...destinationHeader(open!, 2),
      kind: "half-close",
      direction: "destination-to-source",
    });

    await vi.waitFor(() =>
      expect(responseFor(channel, "half-close")).toMatchObject({ status: 200 }),
    );
    await vi.waitFor(() => {
      expect(
        binaryFrames(socket).some(
          (frame) =>
            frame.header.connectionId === open!.connectionId &&
            frame.header.kind === "close",
        ),
      ).toBe(true);
    });
    deliverControl(socket, {
      ...destinationHeader(open!, 3),
      kind: "half-close",
      direction: "destination-to-source",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      binaryFrames(socket).filter(
        (frame) =>
          frame.header.connectionId === open!.connectionId &&
          frame.header.kind === "close",
      ),
    ).toHaveLength(1);
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
  });

  it("retires only the stream whose protected payload cannot be decrypted", async () => {
    const attachment = await startBrowserCodeAttachment(wire());
    const adapterId = attachmentAdapterId(attachment);
    const socket = sockets[0]!;
    const channel = httpChannel();
    channel.receive(httpRequest("corrupt-stream", adapterId));
    channel.receive(httpRequest("healthy-sibling", adapterId));
    const [corrupt, sibling] = await waitForOpenFrames(socket, 2);
    await acceptConnection(socket, corrupt!);
    await acceptConnection(socket, sibling!);

    socket.message(
      toBuffer(
        encodeTunnelDataPlaneFrame(
          {
            ...destinationHeader(corrupt!, 1),
            kind: "data",
            direction: "destination-to-source",
            protection: {
              formatVersion: 1,
              algorithm: "AES-256-GCM",
              keyRevision: 1,
              nonce: encodeBase64Url(new Uint8Array(12)),
            },
          },
          new Uint8Array(17),
        ),
      ),
    );
    await vi.waitFor(() => {
      expect(responseFor(channel, "corrupt-stream")).toHaveProperty("error");
    });

    const response = await protectedDestinationData(
      sibling!,
      1,
      new TextEncoder().encode(
        "HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nsibling",
      ),
    );
    socket.message(
      toBuffer(encodeTunnelDataPlaneFrame(response.header, response.payload)),
    );
    deliverControl(socket, {
      ...destinationHeader(sibling!, 2),
      kind: "half-close",
      direction: "destination-to-source",
    });

    await vi.waitFor(() =>
      expect(responseFor(channel, "healthy-sibling")).toMatchObject({
        status: 200,
      }),
    );
    expect(
      binaryFrames(socket).filter(
        (frame) =>
          frame.header.connectionId === corrupt!.connectionId &&
          frame.header.kind === "close",
      ),
    ).toHaveLength(1);
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
  });

  it("retires a sequence-invalid stream without disturbing its sibling", async () => {
    const attachment = await startBrowserCodeAttachment(wire());
    const adapterId = attachmentAdapterId(attachment);
    const socket = sockets[0]!;
    const channel = httpChannel();
    channel.receive(httpRequest("sequence-invalid", adapterId));
    channel.receive(httpRequest("sequence-sibling", adapterId));
    const [invalid, sibling] = await waitForOpenFrames(socket, 2);
    await acceptConnection(socket, invalid!);
    await acceptConnection(socket, sibling!);

    deliverControl(socket, {
      ...destinationHeader(invalid!, 2),
      kind: "credit",
      direction: "source-to-destination",
      bytes: 1,
    });
    await vi.waitFor(() => {
      expect(responseFor(channel, "sequence-invalid")).toHaveProperty("error");
    });

    const response = await protectedDestinationData(
      sibling!,
      1,
      new TextEncoder().encode(
        "HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nsibling",
      ),
    );
    socket.message(
      toBuffer(encodeTunnelDataPlaneFrame(response.header, response.payload)),
    );
    deliverControl(socket, {
      ...destinationHeader(sibling!, 2),
      kind: "half-close",
      direction: "destination-to-source",
    });
    await vi.waitFor(() =>
      expect(responseFor(channel, "sequence-sibling")).toMatchObject({
        status: 200,
      }),
    );

    deliverControl(socket, {
      ...destinationHeader(invalid!, 3),
      kind: "credit",
      direction: "source-to-destination",
      bytes: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      binaryFrames(socket).filter(
        (frame) =>
          frame.header.connectionId === invalid!.connectionId &&
          frame.header.kind === "close",
      ),
    ).toHaveLength(1);
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
  });

  it("honors a close that races ahead of a pending socket open", async () => {
    vi.useFakeTimers();
    const starting = startBrowserCodeAttachment(wire());
    await vi.advanceTimersByTimeAsync(0);
    const attachment = await starting;
    const adapterId = attachmentAdapterId(attachment);
    const socket = sockets[0]!;
    const target = attachmentFrame(attachment);
    const openRequest = {
      adapterId,
      socketId: "pending-socket",
      type: "cantrip-code-websocket-open-v1",
      url: `https://cantrip.example/__cantrip_code/${adapterId}/code/websocket`,
      protocols: [] as string[],
    };
    window.dispatchEvent(windowMessage(openRequest, target));
    const [open] = await waitForOpenFrames(socket, 1);
    window.dispatchEvent(
      windowMessage(
        {
          adapterId,
          socketId: "pending-socket",
          type: "cantrip-code-websocket-close-v1",
          code: 1000,
          reason: "cancelled before open",
        },
        target,
      ),
    );
    deliverControl(socket, {
      ...destinationHeader(open!, 0),
      kind: "accepted",
      initialCreditBytes: 256 * 1_024,
    });
    await vi.advanceTimersByTimeAsync(0);
    const closeWon = binaryFrames(socket).some(
      (frame) =>
        frame.header.connectionId === open!.connectionId &&
        frame.header.kind === "close",
    );

    deliverControl(socket, {
      ...destinationHeader(open!, 1),
      kind: "close",
      code: "normal",
    });
    await vi.advanceTimersByTimeAsync(15_100);

    expect(closeWon).toBe(true);
    expect(
      target.postMessage.mock.calls.some(
        ([message]) => Reflect.get(message, "event") === "open",
      ),
    ).toBe(false);
  });

  it("does not retain a socket closed in the same relay chunk as its handshake", async () => {
    const attachment = await startBrowserCodeAttachment(wire());
    const adapterId = attachmentAdapterId(attachment);
    const relay = sockets[0]!;
    const target = attachmentFrame(attachment);
    const openRequest = {
      adapterId,
      socketId: "immediately-closed-socket",
      type: "cantrip-code-websocket-open-v1",
      url: `https://cantrip.example/__cantrip_code/${adapterId}/code/websocket`,
      protocols: [] as string[],
    };

    window.dispatchEvent(windowMessage(openRequest, target));
    const [firstOpen] = await waitForOpenFrames(relay, 1);
    await completeBrowserSocketHandshake(
      relay,
      firstOpen!,
      new Uint8Array([0x88, 0x02, 0x03, 0xe8]),
    );
    await vi.waitFor(() => {
      expect(
        target.postMessage.mock.calls.some(
          ([message]) => Reflect.get(message, "event") === "close",
        ),
      ).toBe(true);
    });
    await Promise.resolve();

    window.dispatchEvent(windowMessage(openRequest, target));

    await waitForOpenFrames(relay, 2);
  });

  it("bounds terminal socket cleanup concurrently before deleting the relay attachment", async () => {
    const attachment = await startBrowserCodeAttachment(wire());
    const adapterId = attachmentAdapterId(attachment);
    const relay = sockets[0]!;
    const target = attachmentFrame(attachment);
    const targets = [target, target];
    for (const [index, target] of targets.entries()) {
      window.dispatchEvent(
        windowMessage(
          {
            adapterId,
            socketId: `blocked-socket-${index}`,
            type: "cantrip-code-websocket-open-v1",
            url: `https://cantrip.example/__cantrip_code/${adapterId}/code/websocket`,
            protocols: [] as string[],
          },
          target,
        ),
      );
    }
    const opens = await waitForOpenFrames(relay, targets.length);
    for (const [index, open] of opens.entries()) {
      await completeBrowserSocketHandshake(relay, open);
      await vi.waitFor(() => {
        expect(
          targets[index]!.postMessage.mock.calls.some(
            ([message]) => Reflect.get(message, "event") === "open",
          ),
        ).toBe(true);
      });
    }

    for (const [index, target] of targets.entries()) {
      window.dispatchEvent(
        windowMessage(
          {
            adapterId,
            socketId: `blocked-socket-${index}`,
            type: "cantrip-code-websocket-send-v1",
            data: "x".repeat(256 * 1_024),
          },
          target,
        ),
      );
    }
    await Promise.resolve();
    vi.useFakeTimers();

    let settled = false;
    const stopping = stopBrowserCodeAttachment(TUNNEL_ID).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5_001);
    const settledWithinOneCloseDeadline = settled;
    await vi.advanceTimersByTimeAsync(6_000);
    await stopping;

    expect(settledWithinOneCloseDeadline).toBe(true);
    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledTimes(1);
  });

  it("isolates the fifth five-megabyte socket at the per-session send budget", async () => {
    const attachment = await startBrowserCodeAttachment(wire());
    const adapterId = attachmentAdapterId(attachment);
    const relay = sockets[0]!;
    const { targets } = await openBrowserSockets(relay, attachment, 5);
    const chunk = new ArrayBuffer(5 * 1_024 * 1_024);

    for (const [index, target] of targets.entries()) {
      window.dispatchEvent(
        windowMessage(
          {
            adapterId,
            socketId: `aggregate-socket-${index}`,
            type: "cantrip-code-websocket-send-v1",
            binary: true,
            data: chunk,
          },
          target,
        ),
      );
    }
    await vi.waitFor(() => {
      const closedSocketIds = targets[0]!.postMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => Reflect.get(message, "event") === "close")
        .map((message) => Reflect.get(message, "socketId"));
      expect(closedSocketIds).toContain("aggregate-socket-4");
    });
    const siblingCloses = targets
      .slice(0, 4)
      .map((target, index) =>
        target.postMessage.mock.calls.some(
          ([message]) =>
            Reflect.get(message, "event") === "close" &&
            Reflect.get(message, "socketId") === `aggregate-socket-${index}`,
        ),
      );
    const overflowClose = targets[4]!.postMessage.mock.calls.find(
      ([message]) =>
        Reflect.get(message, "event") === "close" &&
        Reflect.get(message, "socketId") === "aggregate-socket-4",
    )?.[0];
    relay.terminalClose(1006, "test cleanup");

    expect(siblingCloses).toEqual([false, false, false, false]);
    expect(overflowClose).toMatchObject({ code: 1006, wasClean: false });
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
  });

  it("closes only the socket whose incomplete receive exceeds the 32 MiB aggregate", async () => {
    const attachment = await startBrowserCodeAttachment(wire());
    const adapterId = attachmentAdapterId(attachment);
    const relay = sockets[0]!;
    const { opens, targets } = await openBrowserSockets(relay, attachment, 5);
    const incomplete = incompleteWebSocketMessage(7 * 1_024 * 1_024);

    for (const open of opens.slice(0, 4)) {
      await deliverProtectedSocketBytes(relay, open, incomplete, true);
    }
    const fifthOpen = opens[4]!;
    const existingFifthCredits = binaryFrames(relay).filter(
      (frame) =>
        frame.header.connectionId === fifthOpen.connectionId &&
        frame.header.kind === "credit" &&
        frame.header.direction === "destination-to-source",
    ).length;
    await deliverProtectedSocketBytes(relay, fifthOpen, incomplete, false);
    const expectedFifthChunks = Math.ceil(
      incomplete.byteLength / TUNNEL_DATA_PLANE_MAX_PLAINTEXT_BYTES,
    );
    await vi.waitFor(
      () => {
        const closed = targets[4]!.postMessage.mock.calls.some(
          ([message]) =>
            Reflect.get(message, "event") === "close" &&
            Reflect.get(message, "socketId") === "aggregate-socket-4",
        );
        const credits = binaryFrames(relay).filter(
          (frame) =>
            frame.header.connectionId === fifthOpen.connectionId &&
            frame.header.kind === "credit" &&
            frame.header.direction === "destination-to-source",
        ).length;
        expect(
          closed || credits >= existingFifthCredits + expectedFifthChunks,
        ).toBe(true);
      },
      { timeout: 5_000 },
    );
    const siblingCloses = targets
      .slice(0, 4)
      .map((target, index) =>
        target.postMessage.mock.calls.some(
          ([message]) =>
            Reflect.get(message, "event") === "close" &&
            Reflect.get(message, "socketId") === `aggregate-socket-${index}`,
        ),
      );
    const overflowClose = targets[4]!.postMessage.mock.calls.find(
      ([message]) =>
        Reflect.get(message, "event") === "close" &&
        Reflect.get(message, "socketId") === "aggregate-socket-4",
    )?.[0];
    relay.terminalClose(1006, "test cleanup");

    expect(siblingCloses).toEqual([false, false, false, false]);
    expect(overflowClose).toMatchObject({ code: 1009, wasClean: false });
  });

  it("retires and reconnects the exact relay when physical buffered bytes stay above 8 MiB", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T23:00:00.000Z"));
    const starting = startBrowserCodeAttachment(wire());
    await vi.advanceTimersByTimeAsync(0);
    const attachment = await starting;
    const adapterId = attachmentAdapterId(attachment);
    const relay = sockets[0]!;
    relay.bufferedAmount = 8 * 1_024 * 1_024;
    relay.bufferedAmountReads = 0;

    httpChannel().receive(httpRequest("outer-congestion", adapterId));
    for (
      let attempt = 0;
      attempt < 20 && relay.bufferedAmountReads === 0;
      attempt += 1
    ) {
      await Promise.resolve();
    }
    expect(relay.bufferedAmountReads).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(relay.readyState).toBe(FakeWebSocket.CLOSED);
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(2));
    await stopBrowserCodeAttachment(TUNNEL_ID);
  });

  it("rejects non-string offered protocols without escaping the window handler", async () => {
    const attachment = await startBrowserCodeAttachment(wire());
    const adapterId = attachmentAdapterId(attachment);
    const target = attachmentFrame(attachment);

    expect(() =>
      window.dispatchEvent(
        windowMessage(
          {
            adapterId,
            socketId: "invalid-protocols",
            type: "cantrip-code-websocket-open-v1",
            url: `https://cantrip.example/__cantrip_code/${adapterId}/code/websocket`,
            protocols: [1],
          },
          target,
        ),
      ),
    ).not.toThrow();

    expect(binaryFrames(sockets[0]!)).toHaveLength(0);
    expect(
      target.postMessage.mock.calls.some(
        ([message]) => Reflect.get(message, "event") === "error",
      ),
    ).toBe(true);
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
  });

  it("rejects WebSocket requests from a sibling frame with a known adapter id", async () => {
    const attachment = await startBrowserCodeAttachment(wire());
    const adapterId = attachmentAdapterId(attachment);
    const expectedFrame = attachmentFrame(attachment);
    const siblingFrame = { postMessage: vi.fn() };
    const request = {
      adapterId,
      socketId: "frame-bound-socket",
      type: "cantrip-code-websocket-open-v1",
      url: `https://cantrip.example/__cantrip_code/${adapterId}/code/websocket`,
      protocols: [] as string[],
    };

    window.dispatchEvent(windowMessage(request, siblingFrame));
    await Promise.resolve();
    expect(binaryFrames(sockets[0]!)).toHaveLength(0);

    window.dispatchEvent(windowMessage(request, expectedFrame));
    await waitForOpenFrames(sockets[0]!, 1);
  });

  it("accepts WebSocket requests from descendants of the exact bound frame", async () => {
    const attachment = await startBrowserCodeAttachment(wire());
    const adapterId = attachmentAdapterId(attachment);
    const expectedFrame = attachmentFrame(attachment);
    const nestedFrame = {
      parent: expectedFrame,
      postMessage: vi.fn(),
    };

    window.dispatchEvent(
      windowMessage(
        {
          adapterId,
          socketId: "nested-frame-socket",
          type: "cantrip-code-websocket-open-v1",
          url: `https://cantrip.example/__cantrip_code/${adapterId}/code/websocket`,
          protocols: [] as string[],
        },
        nestedFrame,
      ),
    );

    await waitForOpenFrames(sockets[0]!, 1);
  });

  it("rejects WebSocket commands from stale adapter generations and frame nonces", async () => {
    const attachment = await startBrowserCodeAttachment(wire());
    const adapterId = attachmentAdapterId(attachment);
    const target = attachmentFrame(attachment);
    const generation = adapterRegistrationMessages.find(
      (candidate) => candidate.adapterId === adapterId,
    )!.generation;
    const request = {
      adapterId,
      protocols: [] as string[],
      socketId: "generation-fenced-socket",
      type: "cantrip-code-websocket-open-v1",
      url: `https://cantrip.example/__cantrip_code/${adapterId}/code/websocket`,
    };

    window.dispatchEvent(
      windowMessage(
        {
          ...request,
          generation: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        },
        target,
      ),
    );
    window.dispatchEvent(
      windowMessage(
        {
          ...request,
          frameNonce: "stale_browser_code_frame_nonce_1234",
          generation,
        },
        target,
      ),
    );
    await Promise.resolve();
    expect(binaryFrames(sockets[0]!)).toHaveLength(0);

    window.dispatchEvent(windowMessage(request, target));
    await waitForOpenFrames(sockets[0]!, 1);
  });

  it("retires old-frame sockets while preserving the logical session and physical transport", async () => {
    const attachment = await startBrowserCodeAttachment(wire());
    const adapterId = attachmentAdapterId(attachment);
    const relay = sockets[0]!;
    const {
      opens: [liveOpen],
      targets: [oldFrame],
    } = await openBrowserSockets(relay, attachment, 1);
    if (!liveOpen || !oldFrame) throw new Error("Live socket did not open.");

    window.dispatchEvent(
      windowMessage(
        {
          adapterId,
          protocols: [] as string[],
          socketId: "pending-frame-socket",
          type: "cantrip-code-websocket-open-v1",
          url: `https://cantrip.example/__cantrip_code/${adapterId}/code/websocket`,
        },
        oldFrame,
      ),
    );
    const [, pendingOpen] = await waitForOpenFrames(relay, 2);
    if (!pendingOpen) throw new Error("Pending socket did not allocate.");

    const replacementNonce = "replacement_browser_code_nonce_5678";
    const replacementFrame = { postMessage: vi.fn() };
    bindBrowserCodeAttachmentFrame(
      attachment.attachmentId,
      replacementFrame as unknown as WindowProxy,
      replacementNonce,
    );

    await vi.waitFor(() => {
      expect(
        binaryFrames(relay).some(
          (frame) =>
            frame.header.connectionId === pendingOpen.connectionId &&
            frame.header.kind === "close",
        ),
      ).toBe(true);
      expect(
        oldFrame.postMessage.mock.calls.some(
          ([message]) =>
            Reflect.get(message, "event") === "close" &&
            Reflect.get(message, "socketId") === "aggregate-socket-0" &&
            Reflect.get(message, "frameNonce") === FRAME_NONCE,
        ),
      ).toBe(true);
    });

    expect(sockets).toHaveLength(1);
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
    expect(mocks.deleteTunnelAttachment).not.toHaveBeenCalled();
    expect(
      oldFrame.postMessage.mock.calls.some(
        ([message]) =>
          Reflect.get(message, "event") === "open" &&
          Reflect.get(message, "socketId") === "pending-frame-socket",
      ),
    ).toBe(false);

    window.dispatchEvent(
      windowMessage(
        {
          adapterId,
          frameNonce: replacementNonce,
          protocols: [] as string[],
          socketId: "replacement-frame-socket",
          type: "cantrip-code-websocket-open-v1",
          url: `https://cantrip.example/__cantrip_code/${adapterId}/code/websocket`,
        },
        replacementFrame,
      ),
    );
    await waitForOpenFrames(relay, 3);
    expect(sockets).toHaveLength(1);
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
  });

  it("restores an exact frame-approved blob lineage across service-worker restart", async () => {
    const attachment = await startBrowserCodeAttachment(wire());
    const adapterId = attachmentAdapterId(attachment);
    const frame = attachmentFrame(attachment);
    const initial = adapterRegistrationMessages[0]!;
    const lineageToken = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    window.dispatchEvent(
      windowMessage(
        {
          adapterId,
          frameNonce: FRAME_NONCE,
          generation: initial.generation,
          lineageToken,
          type: "cantrip-code-worker-lineage-v2",
        },
        frame,
      ),
    );
    expect(httpChannel(adapterId).messages).toContainEqual({
      adapterId,
      frameNonce: FRAME_NONCE,
      generation: initial.generation,
      lineageToken,
      type: "cantrip-code-adapter-lineage-v2",
    });

    const replacement = fakeServiceWorkerEndpoint();
    fakeServiceWorkerContainer.controller = replacement;
    fakeServiceWorkerContainer.ready = Promise.resolve({
      active: replacement,
    });
    fakeServiceWorkerContainer.dispatchEvent(
      serviceWorkerMessage(
        {
          adapterFingerprint: await adapterFingerprint(adapterId),
          type: "cantrip-code-adapter-registration-required-v2",
        },
        replacement,
      ),
    );

    await vi.waitFor(() => expect(adapterRegistrationMessages).toHaveLength(2));
    expect(adapterRegistrationMessages[1]).toEqual({
      adapterId,
      frameNonce: FRAME_NONCE,
      generation: initial.generation,
      lineageToken,
      rootLease: initial.rootLease,
    });
  });

  it("rejects an invalid workspace before allocating a relay attachment", async () => {
    const invalid = wire();
    invalid.runtime.workspaceUri = "https://example.com/not-a-workspace";

    await expect(startBrowserCodeAttachment(invalid)).rejects.toThrow(
      "invalid workspace URI",
    );

    expect(mocks.createTunnelAttachment).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(false);
  });

  it("releases the relay when session construction fails after startup", async () => {
    class FailingMessageChannel {
      constructor() {
        throw new Error("MessageChannel construction failed.");
      }
    }
    vi.stubGlobal("MessageChannel", FailingMessageChannel);

    await expect(startBrowserCodeAttachment(wire())).rejects.toThrow(
      "MessageChannel construction failed.",
    );

    expect(mocks.createTunnelAttachment).toHaveBeenCalledOnce();
    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledWith(
      "browser-attachment-1",
      { signal: expect.any(AbortSignal) },
    );
    expect(sockets[0]?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(false);
  });

  it("fails immediately when the service worker rejects adapter ownership", async () => {
    rejectAdapterRegistrations = true;

    await expect(startBrowserCodeAttachment(wire())).rejects.toThrow(
      "already registered",
    );

    expect(mocks.createTunnelAttachment).toHaveBeenCalledOnce();
    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledOnce();
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(false);
  });

  it("evicts and reports the current session when relay recovery expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
    const unavailable = vi.fn();
    const unsubscribe = subscribeBrowserCodeAttachmentUnavailable(unavailable);
    await startBrowserCodeAttachment(wire());

    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
    autoOpenSockets = false;
    sockets[0]!.terminalClose();
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
    await vi.advanceTimersByTimeAsync(15_001);

    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(false);
    expect(unavailable).toHaveBeenCalledWith({
      tunnelId: TUNNEL_ID,
      reason: "Protected Code relay recovery timed out.",
    });
    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledWith(
      "browser-attachment-1",
      { signal: expect.any(AbortSignal) },
    );
    unsubscribe();
  });

  it("does not let a replaced session evict the current healthy session", async () => {
    const unavailable = vi.fn();
    const unsubscribe = subscribeBrowserCodeAttachmentUnavailable(unavailable);
    await startBrowserCodeAttachment(wire());
    const replacedSocket = sockets[0]!;

    await startBrowserCodeAttachment(wire());
    replacedSocket.terminalClose();

    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
    expect(unavailable).not.toHaveBeenCalled();

    mocks.getActiveServerUrl.mockReturnValue("https://other-account.example");
    sockets[1]!.terminalError();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(false);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledWith({
      tunnelId: TUNNEL_ID,
      reason: "Protected Code server or account identity changed.",
    });
    unsubscribe();
  });

  it("retires a slower concurrent start instead of leaking or overwriting the winner", async () => {
    autoReadySockets = false;
    const first = startBrowserCodeAttachment(wire()).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const second = startBrowserCodeAttachment(wire());
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    sockets[1]!.ready();
    await expect(second).resolves.toMatchObject({
      attachmentId: TUNNEL_ID,
    });
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);

    sockets[0]!.ready();
    await expect(first).resolves.toMatchObject({
      message: "Protected Code attachment startup was superseded.",
      name: "AbortError",
    });
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledWith(
      "browser-attachment-1",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("fences a pending start when shutdown wins the race", async () => {
    autoReadySockets = false;
    const pending = startBrowserCodeAttachment(wire()).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    await stopBrowserCodeAttachment(TUNNEL_ID);
    sockets[0]!.ready();

    await expect(pending).resolves.toMatchObject({
      message: "Protected Code attachment startup was superseded.",
      name: "AbortError",
    });
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(false);
    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledWith(
      "browser-attachment-1",
      { signal: expect.any(AbortSignal) },
    );
  });
});
