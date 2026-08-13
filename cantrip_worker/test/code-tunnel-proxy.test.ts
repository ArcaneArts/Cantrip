import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import {
  CODE_ADAPTER_TUNNEL_INITIAL_CREDIT_BYTES,
  CODE_ADAPTER_WEBSOCKET_BINARY_RECORD,
  CODE_ADAPTER_WEBSOCKET_RECORD_HEADER_BYTES,
  CODE_ADAPTER_WEBSOCKET_TEXT_RECORD,
  TUNNEL_DATA_PLANE_MAX_CREDIT_BYTES,
  TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES,
  type CodeAdapterRequestHead,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import type { CodeSupervisor } from "../src/code/supervisor.js";
import {
  codeDiagnosticPath,
  codeEditorTargetUrl,
  CodeTunnelProxy,
} from "../src/code/tunnel-proxy.js";

const closers: Array<() => Promise<void> | void> = [];
const EMPTY_PAYLOAD = new Uint8Array();

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function encodeHead(head: CodeAdapterRequestHead): Buffer {
  const body = Buffer.from(JSON.stringify(head));
  const output = Buffer.allocUnsafe(4 + body.length);
  output.writeUInt32BE(body.length, 0);
  body.copy(output, 4);
  return output;
}

function websocketRecord(kind: number, payload: Uint8Array): Buffer {
  const output = Buffer.allocUnsafe(
    CODE_ADAPTER_WEBSOCKET_RECORD_HEADER_BYTES + payload.byteLength,
  );
  output[0] = kind;
  output.writeUInt32BE(payload.byteLength, 1);
  output.set(payload, CODE_ADAPTER_WEBSOCKET_RECORD_HEADER_BYTES);
  return output;
}

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
        ? Buffer.alloc(TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES + 1, "x")
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
        codeTabId: "code-1",
        connectionToken: "worker-local-secret",
        editorOrigin: `http://127.0.0.1:${port}`,
        processInstanceId: "process-1",
        workspaceUri: "file:///worker/state/project.code-workspace",
      };
    },
  } as unknown as CodeSupervisor;
  const frames: Array<{
    header: TunnelDataPlaneFrameHeader;
    payload: Uint8Array;
  }> = [];
  const proxy = new CodeTunnelProxy(supervisor);
  proxy.setFrameEmitter((header, payload) => {
    frames.push({ header, payload: Uint8Array.from(payload) });
    return true;
  });
  closers.push(() => proxy.close());
  return {
    beginTunnelStream,
    endTunnelStream,
    frames,
    observedRequest: () => observedRequest,
    observedWebSocketData: () => observedWebSocketData,
    proxy,
  };
}

const connect: Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }> = {
  protocolVersion: 1,
  tunnelId: "tunnel-1",
  attachmentId: "attachment-1",
  sourceEndpointId: "server-code-1",
  destinationEndpointId: "worker-code-1",
  connectionId: "connection-1",
  sequence: 0,
  kind: "connect",
  target: { kind: "adapter", adapter: "code", resourceId: "code-1" },
  initialCreditBytes: TUNNEL_DATA_PLANE_MAX_CREDIT_BYTES,
};

function inputHeader(
  sequence: number,
  kind:
    | { kind: "data"; direction: "source-to-destination" }
    | { kind: "half-close"; direction: "source-to-destination" },
): TunnelDataPlaneFrameHeader {
  return { ...connect, ...kind, sequence } as TunnelDataPlaneFrameHeader;
}

function outputBytes(
  frames: Array<{ header: TunnelDataPlaneFrameHeader; payload: Uint8Array }>,
): Buffer {
  return Buffer.concat(
    frames
      .filter(
        ({ header }) =>
          header.kind === "data" &&
          header.direction === "destination-to-source",
      )
      .map(({ payload }) => Buffer.from(payload)),
  );
}

function decodedOutput(
  frames: Array<{ header: TunnelDataPlaneFrameHeader; payload: Uint8Array }>,
) {
  const bytes = outputBytes(frames);
  const headLength = bytes.readUInt32BE(0);
  return {
    body: bytes.subarray(4 + headLength),
    head: JSON.parse(bytes.subarray(4, 4 + headLength).toString("utf8")) as {
      headers: Array<[string, string]>;
      kind: "http" | "websocket";
      statusCode?: number;
    },
  };
}

describe("Cantrip Code worker tunnel proxy", () => {
  it("grants enough initial credit for a maximum-size WebSocket record", async () => {
    const { frames, proxy } = await fixture();

    proxy.handleFrame(connect, EMPTY_PAYLOAD);

    expect(frames).toContainEqual(
      expect.objectContaining({
        header: expect.objectContaining({
          kind: "accepted",
          initialCreditBytes: CODE_ADAPTER_TUNNEL_INITIAL_CREDIT_BYTES,
        }),
      }),
    );
  });

  it("redacts attachment capabilities from diagnostic paths", () => {
    const basePath = `/code/${"a".repeat(43)}`;

    expect(
      codeDiagnosticPath(`${basePath}/?workspace=/private/repo`, basePath),
    ).toBe("/");
    expect(
      codeDiagnosticPath(`${basePath}/stable/workbench.js`, basePath),
    ).toBe("/stable/workbench.js");
    expect(codeDiagnosticPath("/code/unrelated/private", basePath)).toBe(
      "[outside attachment]",
    );
  });

  it("opens direct attachments as remote workspace paths", () => {
    expect(
      codeEditorTargetUrl(
        "http://127.0.0.1:4311",
        "/code/",
        "/code",
        "file:///worker/My%20Project/project.code-workspace",
      ).toString(),
    ).toBe(
      "http://127.0.0.1:4311/?workspace=%2Fworker%2FMy+Project%2Fproject.code-workspace",
    );
  });

  it("rejects a session that does not belong to the tunnel's Code tab", async () => {
    const { beginTunnelStream, frames, proxy } = await fixture();
    const mismatched = {
      ...connect,
      target: { kind: "adapter", adapter: "code", resourceId: "code-2" },
    } as Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>;
    proxy.handleFrame(mismatched, EMPTY_PAYLOAD);
    proxy.handleFrame(
      {
        ...inputHeader(1, { kind: "data", direction: "source-to-destination" }),
        target: mismatched.target,
      },
      encodeHead({
        protocolVersion: 1,
        kind: "http",
        sessionId: "session-1",
        method: "GET",
        path: "/code/public-token/",
        basePath: "/code/public-token",
        headers: [],
      }),
    );
    expect(beginTunnelStream).not.toHaveBeenCalled();
    expect(frames).toContainEqual(
      expect.objectContaining({
        header: expect.objectContaining({
          kind: "close",
          code: "protocol-error",
        }),
      }),
    );
  });

  it("routes HTTP over generic streams and keeps editor credentials local", async () => {
    const {
      beginTunnelStream,
      endTunnelStream,
      frames,
      observedRequest,
      proxy,
    } = await fixture();
    proxy.handleFrame(connect, EMPTY_PAYLOAD);
    proxy.handleFrame(
      inputHeader(1, { kind: "data", direction: "source-to-destination" }),
      encodeHead({
        protocolVersion: 1,
        kind: "http",
        sessionId: "session-1",
        method: "GET",
        path: "/code/public-token/",
        basePath: "/code/public-token",
        headers: [
          ["x-forwarded-host", "code.cantrip.art"],
          ["authorization", "Bearer app-secret"],
          ["cookie", "cantrip-session=app-secret"],
        ],
      }),
    );
    proxy.handleFrame(
      inputHeader(2, {
        kind: "half-close",
        direction: "source-to-destination",
      }),
      EMPTY_PAYLOAD,
    );

    await vi.waitFor(() =>
      expect(
        frames.some(
          ({ header }) =>
            header.kind === "half-close" &&
            header.direction === "destination-to-source",
        ),
      ).toBe(true),
    );
    const request = observedRequest();
    expect(request?.url).toContain(
      "/?workspace=%2Fworker%2Fstate%2Fproject.code-workspace",
    );
    expect(request?.headers["x-forwarded-prefix"]).toBe("/code/public-token");
    expect(request?.headers["x-forwarded-host"]).toBe("code.cantrip.art");
    expect(request?.headers.authorization).toBeUndefined();
    expect(request?.headers.cookie).toBe("vscode-tkn=worker-local-secret");
    const output = decodedOutput(frames);
    expect(output.head).toMatchObject({ kind: "http", statusCode: 200 });
    expect(
      output.head.headers.map(([name]) => name.toLowerCase()),
    ).not.toContain("set-cookie");
    expect(output.body.toString()).toBe("editor-ready");
    expect(JSON.stringify(frames)).not.toContain("worker-local-secret");
    expect(beginTunnelStream).toHaveBeenCalledWith(
      "session-1",
      "tunnel-1\0attachment-1\0connection-1",
    );
    proxy.handleFrame(
      { ...connect, kind: "close", sequence: 3, reason: "normal" },
      EMPTY_PAYLOAD,
    );
    expect(endTunnelStream).toHaveBeenCalledWith(
      "session-1",
      "tunnel-1\0attachment-1\0connection-1",
    );
  });

  it("preserves WebSocket message types and translates only editor auth", async () => {
    const { frames, observedWebSocketData, proxy } = await fixture();
    proxy.handleFrame(connect, EMPTY_PAYLOAD);
    proxy.handleFrame(
      inputHeader(1, { kind: "data", direction: "source-to-destination" }),
      encodeHead({
        protocolVersion: 1,
        kind: "websocket",
        sessionId: "session-1",
        path: "/code/public-token/socket",
        basePath: "/code/public-token",
        headers: [],
      }),
    );
    await vi.waitFor(() =>
      expect(outputBytes(frames).byteLength).toBeGreaterThan(4),
    );
    expect(decodedOutput(frames).head.kind).toBe("websocket");

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
    proxy.handleFrame(
      inputHeader(2, { kind: "data", direction: "source-to-destination" }),
      websocketRecord(
        CODE_ADAPTER_WEBSOCKET_BINARY_RECORD,
        authenticationFrame,
      ),
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

    proxy.handleFrame(
      inputHeader(3, { kind: "data", direction: "source-to-destination" }),
      websocketRecord(CODE_ADAPTER_WEBSOCKET_TEXT_RECORD, Buffer.from("ping")),
    );
    await vi.waitFor(() =>
      expect(outputBytes(frames).includes(Buffer.from("ping"))).toBe(true),
    );
    const output = decodedOutput(frames).body;
    expect(output.includes(Buffer.from("sign"))).toBe(true);
    expect(output.includes(Buffer.from("ping"))).toBe(true);
    expect(JSON.stringify(frames)).not.toContain("worker-local-secret");
  });

  it("splits large HTTP output at the generic frame boundary", async () => {
    const { frames, proxy } = await fixture();
    proxy.handleFrame(connect, EMPTY_PAYLOAD);
    proxy.handleFrame(
      inputHeader(1, { kind: "data", direction: "source-to-destination" }),
      encodeHead({
        protocolVersion: 1,
        kind: "http",
        sessionId: "session-1",
        method: "GET",
        path: "/code/public-token/large",
        basePath: "/code/public-token",
        headers: [],
      }),
    );
    proxy.handleFrame(
      inputHeader(2, {
        kind: "half-close",
        direction: "source-to-destination",
      }),
      EMPTY_PAYLOAD,
    );

    await vi.waitFor(() =>
      expect(
        frames.some(
          ({ header }) =>
            header.kind === "half-close" &&
            header.direction === "destination-to-source",
        ),
      ).toBe(true),
    );
    const chunks = frames.filter(
      ({ header }) =>
        header.kind === "data" && header.direction === "destination-to-source",
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every(
        ({ payload }) =>
          payload.byteLength <= TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES,
      ),
    ).toBe(true);
    expect(decodedOutput(frames).body.byteLength).toBe(
      TUNNEL_DATA_PLANE_MAX_PAYLOAD_BYTES + 1,
    );
  });
});
