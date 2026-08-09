import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import {
  CODE_TUNNEL_MAX_PAYLOAD_BYTES,
  type CodeTunnelFrameHeader,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import type { CodeSupervisor } from "../src/code/supervisor.js";
import { CodeTunnelProxy } from "../src/code/tunnel-proxy.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function fixture() {
  let observedRequest: IncomingMessage | null = null;
  let observedWebSocketData: Uint8Array | null = null;
  const server = createServer((request, response) => {
    observedRequest = request;
    response.writeHead(200, {
      "content-type": "text/plain",
      "set-cookie": "vscode-tkn=must-not-leave-worker",
    });
    response.end(
      request.url === "/large"
        ? Buffer.alloc(CODE_TUNNEL_MAX_PAYLOAD_BYTES + 1, "x")
        : "editor-ready",
    );
  });
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    observedRequest = request;
    webSockets.handleUpgrade(request, socket, head, (client) => {
      client.on("message", (data, binary) => {
        if (observedWebSocketData === null) {
          observedWebSocketData = Uint8Array.from(data as Buffer);
          client.send("sign", { binary: true });
        } else {
          client.send(data, { binary });
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  closers.push(async () => {
    for (const client of webSockets.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => webSockets.close(() => resolve()));
  });

  const beginTunnelStream = vi.fn();
  const endTunnelStream = vi.fn();
  const supervisor = {
    beginTunnelStream,
    endTunnelStream,
    proxyTarget(sessionId: string) {
      if (sessionId !== "session-1") throw new Error("Unknown session");
      return {
        connectionToken: "worker-local-secret",
        editorOrigin: `http://127.0.0.1:${port}`,
        processInstanceId: "process-1",
        workspaceUri: "file:///worker/state/project.code-workspace",
      };
    },
  } as unknown as CodeSupervisor;
  const frames: Array<{
    header: CodeTunnelFrameHeader;
    payload: Uint8Array;
  }> = [];
  const proxy = new CodeTunnelProxy(supervisor);
  proxy.setFrameEmitter((header, payload) => {
    frames.push({ header, payload: Uint8Array.from(payload) });
    return true;
  });
  closers.push(async () => proxy.close());
  return {
    beginTunnelStream,
    endTunnelStream,
    frames,
    observedRequest: () => observedRequest,
    observedWebSocketData: () => observedWebSocketData,
    proxy,
  };
}

const base = {
  protocolVersion: 1 as const,
  attachmentId: "attachment-1",
  sessionId: "session-1",
  streamId: "stream-1",
};

describe("Cantrip Code worker tunnel proxy", () => {
  it("routes HTTP only to the selected session and keeps editor credentials local", async () => {
    const {
      beginTunnelStream,
      endTunnelStream,
      frames,
      observedRequest,
      proxy,
    } = await fixture();
    await proxy.handleFrame(
      {
        ...base,
        kind: "http-request-start",
        method: "GET",
        path: "/code/public-token/",
        basePath: "/code/public-token",
        headers: [
          ["x-forwarded-host", "code.cantrip.art"],
          ["authorization", "Bearer app-secret"],
          ["cookie", "cantrip-session=app-secret"],
        ],
      },
      new Uint8Array(),
    );
    await proxy.handleFrame(
      { ...base, kind: "http-request-end" },
      new Uint8Array(),
    );

    await vi.waitFor(() =>
      expect(
        frames.some(({ header }) => header.kind === "http-response-end"),
      ).toBe(true),
    );
    const request = observedRequest();
    expect(request?.url).toContain(
      "/?workspace=file%3A%2F%2F%2Fworker%2Fstate%2Fproject.code-workspace",
    );
    expect(request?.headers["x-forwarded-prefix"]).toBe("/code/public-token");
    expect(request?.headers["x-forwarded-host"]).toBe("code.cantrip.art");
    expect(request?.headers.authorization).toBeUndefined();
    expect(request?.headers.cookie).toBe("vscode-tkn=worker-local-secret");
    const start = frames.find(
      ({ header }) => header.kind === "http-response-start",
    )?.header;
    expect(start).toMatchObject({
      kind: "http-response-start",
      statusCode: 200,
    });
    if (start?.kind === "http-response-start") {
      expect(start.headers.map(([name]) => name.toLowerCase())).not.toContain(
        "set-cookie",
      );
    }
    expect(
      Buffer.concat(
        frames
          .filter(({ header }) => header.kind === "http-response-data")
          .map(({ payload }) => Buffer.from(payload)),
      ).toString(),
    ).toBe("editor-ready");
    expect(JSON.stringify(frames)).not.toContain("worker-local-secret");
    expect(beginTunnelStream).toHaveBeenCalledWith(
      "session-1",
      "attachment-1\0stream-1",
    );
    expect(endTunnelStream).toHaveBeenCalledWith(
      "session-1",
      "attachment-1\0stream-1",
    );
  });

  it("carries full-duplex WebSocket messages without exposing a raw port", async () => {
    const { frames, observedWebSocketData, proxy } = await fixture();
    await proxy.handleFrame(
      {
        ...base,
        kind: "websocket-open",
        path: "/code/public-token/socket",
        basePath: "/code/public-token",
        headers: [],
      },
      new Uint8Array(),
    );
    await vi.waitFor(() =>
      expect(
        frames.some(({ header }) => header.kind === "websocket-opened"),
      ).toBe(true),
    );
    const authentication = Buffer.from(
      JSON.stringify({
        type: "auth",
        auth: "browser-placeholder",
        data: "nonce",
      }),
    );
    const authenticationFrame = Buffer.alloc(13 + authentication.length);
    authenticationFrame.writeUInt8(2, 0);
    authenticationFrame.writeUInt32BE(authentication.length, 9);
    authentication.copy(authenticationFrame, 13);
    await proxy.handleFrame(
      { ...base, kind: "websocket-data", binary: true },
      authenticationFrame,
    );
    await vi.waitFor(() => expect(observedWebSocketData()).not.toBeNull());
    const forwarded = Buffer.from(observedWebSocketData()!);
    const forwardedLength = forwarded.readUInt32BE(9);
    expect(
      JSON.parse(forwarded.subarray(13, 13 + forwardedLength).toString()),
    ).toMatchObject({
      type: "auth",
      auth: "worker-local-secret",
      data: "nonce",
    });
    await proxy.handleFrame(
      { ...base, kind: "websocket-data", binary: false },
      new TextEncoder().encode("ping"),
    );
    await vi.waitFor(() =>
      expect(
        frames.some(
          ({ header, payload }) =>
            header.kind === "websocket-data" &&
            new TextDecoder().decode(payload) === "ping",
        ),
      ).toBe(true),
    );
    expect(JSON.stringify(frames)).not.toContain("worker-local-secret");
  });

  it("splits large HTTP response chunks at the protocol frame boundary", async () => {
    const { frames, proxy } = await fixture();
    await proxy.handleFrame(
      {
        ...base,
        kind: "http-request-start",
        method: "GET",
        path: "/code/public-token/large",
        basePath: "/code/public-token",
        headers: [],
      },
      new Uint8Array(),
    );
    await proxy.handleFrame(
      { ...base, kind: "http-request-end" },
      new Uint8Array(),
    );

    await vi.waitFor(() =>
      expect(
        frames.some(({ header }) => header.kind === "http-response-end"),
      ).toBe(true),
    );
    const chunks = frames.filter(
      ({ header }) => header.kind === "http-response-data",
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every(
        ({ payload }) => payload.byteLength <= CODE_TUNNEL_MAX_PAYLOAD_BYTES,
      ),
    ).toBe(true);
    expect(
      chunks.reduce((total, { payload }) => total + payload.byteLength, 0),
    ).toBe(CODE_TUNNEL_MAX_PAYLOAD_BYTES + 1);
  });
});
