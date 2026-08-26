import {
  decodeWorkerLinkFrame,
  type DirectAttachmentTicket,
  type WorkerLinkFrameHeader,
  type WorkerLinkSession,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  openWorkerLinkLocalCarrier,
  openWorkerLinkRelayCarrier,
  type WorkerLinkWebSocketLike,
} from "./worker-link-carriers";

const session: WorkerLinkSession = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  identity: {
    serverId: "server-1",
    serverGeneration: "server-generation-1",
    ownerId: "owner-1",
    accountSessionId: "account-session-1",
    clientInstanceId: "client-instance-1",
    workerId: "worker-1",
    workerProcessGeneration: "worker-generation-1",
  },
  lease: {
    issuedAt: "2026-08-26T12:00:00.000Z",
    expiresAt: "2099-08-26T12:05:00.000Z",
    absoluteExpiresAt: "2099-08-26T13:00:00.000Z",
  },
  routePolicy: {
    priority: ["local", "lan", "wan", "relay"],
    enabled: ["local", "relay"],
  },
  routeGeneration: 1,
  preferredRoute: "local",
};

type SocketListener = {
  listener: (event: Event | MessageEvent) => void;
  once: boolean;
};

class FakeSocket implements WorkerLinkWebSocketLike {
  binaryType = "blob";
  bufferedAmount = 0;
  closed = false;
  readonly listeners = new Map<string, SocketListener[]>();
  readyState = 0;
  readonly sent: Array<string | Blob | BufferSource> = [];

  constructor(
    readonly url: string,
    private readonly onSend?: (data: string | Blob | BufferSource) => void,
  ) {}

  addEventListener(
    event: "open" | "close" | "error",
    listener: (event: Event) => void,
    options?: { once?: boolean },
  ): void;
  addEventListener(
    event: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  addEventListener(
    event: "open" | "close" | "error" | "message",
    listener: ((event: Event) => void) | ((event: MessageEvent) => void),
    options?: { once?: boolean },
  ): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push({
      listener: listener as (event: Event | MessageEvent) => void,
      once: options?.once ?? false,
    });
    this.listeners.set(event, listeners);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", new Event("close"));
  }

  removeEventListener(
    event: "open" | "close" | "error",
    listener: (event: Event) => void,
  ): void;
  removeEventListener(
    event: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    event: "open" | "close" | "error" | "message",
    listener: ((event: Event) => void) | ((event: MessageEvent) => void),
  ): void {
    const listeners = this.listeners.get(event);
    const index = listeners?.findIndex((entry) => entry.listener === listener);
    if (listeners && index !== undefined && index >= 0)
      listeners.splice(index, 1);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  send(data: string | Blob | BufferSource): void {
    this.sent.push(data);
    this.onSend?.(data);
  }

  message(data: unknown): void {
    this.emit("message", new MessageEvent("message", { data }));
  }

  private emit(event: string, value: Event): void {
    const listeners = [...(this.listeners.get(event) ?? [])];
    for (const entry of listeners) {
      entry.listener(value);
      if (entry.once) {
        const current = this.listeners.get(event);
        current?.splice(current.indexOf(entry), 1);
      }
    }
  }
}

const closeHeader: WorkerLinkFrameHeader = {
  protocolVersion: 1,
  sessionId: session.sessionId,
  routeGeneration: 1,
  effectiveRoute: "relay",
  channel: {
    channelId: "22222222-2222-4222-8222-222222222222",
    connectionId: "33333333-3333-4333-8333-333333333333",
  },
  lane: "interactive",
  sequence: 1,
  kind: "close",
  code: "normal",
};

describe("WorkerLink carriers", () => {
  it("builds the authenticated server RELAY URL and forwards binary frames", async () => {
    let socket!: FakeSocket;
    const carrierPromise = openWorkerLinkRelayCarrier({
      browserOrigin: "https://browser.invalid",
      clientInstanceId: session.identity.clientInstanceId,
      createWebSocket: (url) => {
        socket = new FakeSocket(url);
        queueMicrotask(() => socket.open());
        return socket;
      },
      serverUrl: "https://cantrip.example/base",
      session,
    });
    const carrier = await carrierPromise;
    expect(socket.url).toBe(
      "wss://cantrip.example/api/worker-links/11111111-1111-4111-8111-111111111111/connect?clientInstanceId=client-instance-1",
    );
    expect(carrier.send(closeHeader, new Uint8Array())).toBe(true);
    const sent = socket.sent[0];
    if (!(sent instanceof ArrayBuffer))
      throw new Error("Missing binary frame.");
    expect(decodeWorkerLinkFrame(new Uint8Array(sent)).header).toEqual(
      closeHeader,
    );
    carrier.close();
  });

  it("accepts LOCAL only after the loopback broker proves its ephemeral identity", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]);
    const publicKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", keyPair.publicKey),
    );
    const fingerprint = hex(
      new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey)),
    );
    const ticket: DirectAttachmentTicket = {
      broker: {
        available: true,
        leaseRenewal: true,
        protocol: "ws-v1",
        loopbackHost: "127.0.0.1",
        loopbackPort: 43123,
        instanceId: "44444444-4444-4444-8444-444444444444",
        publicKey: base64Url(publicKey),
        fingerprint,
      },
      binding: {
        capabilityId: "55555555-5555-4555-8555-555555555555",
        ownerId: "owner-1",
        authSessionId: "account-session-1",
        workerId: "worker-1",
        resourceKind: "worker-link",
        resourceId: session.sessionId,
        attachmentId: session.sessionId,
        channels: ["worker-link"],
        expiresAt: "2099-08-26T12:05:00.000Z",
        leaseExpiresAt: "2099-08-26T12:01:00.000Z",
      },
      secret: "s".repeat(43),
    };
    let socket!: FakeSocket;
    const released = vi.fn(async () => undefined);
    const carrierPromise = openWorkerLinkLocalCarrier({
      createTicket: async () => ticket,
      createWebSocket: (url) => {
        socket = new FakeSocket(url, (data) => {
          if (typeof data !== "string") return;
          const initialize = JSON.parse(data) as { challenge: string };
          void crypto.subtle
            .sign(
              { name: "Ed25519" },
              keyPair.privateKey,
              new TextEncoder().encode(
                `cantrip-direct-v1\0${ticket.binding.capabilityId}\0${initialize.challenge}`,
              ),
            )
            .then((signature) =>
              socket.message(
                JSON.stringify({
                  type: "ready",
                  directSessionId: "66666666-6666-4666-8666-666666666666",
                  brokerInstanceId: ticket.broker.instanceId,
                  fingerprint,
                  challenge: initialize.challenge,
                  signature: base64Url(new Uint8Array(signature)),
                  leaseExpiresAt: ticket.binding.leaseExpiresAt,
                }),
              ),
            );
        });
        queueMicrotask(() => socket.open());
        return socket;
      },
      recordActivity: async () => undefined,
      releaseCapability: released,
      session,
    });

    const carrier = await carrierPromise;
    expect(carrier.route).toBe("local");
    expect(socket.url).toBe("ws://127.0.0.1:43123/direct/v1");
    expect(ticket.secret).toBe("");
    carrier.close();
    await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
  });
});

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
