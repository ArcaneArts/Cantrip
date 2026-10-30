// Real HTTP Digest/WebDAV inside authenticated tunnel frames. Only the source
// endpoint is controlled; browser transport, grant APIs and worker are unchanged.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { repositoryRoot } from "./build.mjs";
import { eventually } from "./full-worker.mjs";
import {
  sealTunnelDataFrame,
  openTunnelDataFrame,
} from "../../cantrip_worker/src/tunnel-data-protection.ts";

export async function openShareCarrier(
  page,
  tunnelId,
  workerId,
  kind = "link",
) {
  const key = randomUUID();
  const opened = await page.evaluate(
    async ({ key, tunnelId, workerId, kind, schemaUrl }) => {
      const api = await import("/src/lib/api/tunnels.ts");
      const protocol = await import(schemaUrl);
      const attachment = await api.createTunnelAttachment(tunnelId, {
        clientId: "actual-webdav-" + key,
      });
      const configuration = await api.getTunnelTransportConfiguration(tunnelId);
      const state = { frames: [], closed: null, protocol, attachment };
      (window.shareCarriers ??= {})[key] = state;
      const receive = (bytes) => {
        const frame = protocol.decodeTunnelDataPlaneFrame(bytes);
        state.frames.push({
          header: frame.header,
          payload: [...frame.payload],
        });
      };
      let route;
      if (kind === "link") {
        const transport = await import("/src/lib/tunnel-worker-link.ts");
        state.link = await transport.openTunnelWorkerLink({
          attachmentId: attachment.attachmentId,
          workerId,
          onClose: (code) => {
            state.closed = code;
          },
          onFrame: receive,
        });
        state.link.activate();
        route = state.link.tunnelRoute;
        state.send = (bytes) => {
          if (!state.link.send(bytes))
            throw new Error("Share frame not admitted");
        };
        state.close = () => state.link.close();
      } else {
        const { getActiveServerUrl } =
          await import("/src/lib/server-connections.ts");
        const socket = new WebSocket(
          getActiveServerUrl().replace(/^http/, "ws") + attachment.connectPath,
          ["cantrip-tunnel-v1." + attachment.secret],
        );
        state.socket = socket;
        socket.binaryType = "arraybuffer";
        route = await new Promise((resolve, reject) => {
          socket.onopen = () =>
            socket.send(
              JSON.stringify({
                type: "initialize",
                clientId: "actual-webdav-" + key,
              }),
            );
          socket.onclose = (event) => {
            state.closed = { code: event.code, reason: event.reason };
            reject(
              new Error("Share carrier closed before ready: " + event.reason),
            );
          };
          socket.onerror = () => reject(new Error("Share carrier failed"));
          socket.onmessage = (event) => {
            if (typeof event.data === "string")
              resolve(
                protocol.tunnelAttachmentReadySchema.parse(
                  JSON.parse(event.data),
                ),
              );
            else receive(new Uint8Array(event.data));
          };
        });
        state.send = (bytes) => socket.send(bytes);
        state.close = () => socket.close();
      }
      return { attachment, configuration, route };
    },
    {
      key,
      tunnelId,
      workerId,
      kind,
      schemaUrl:
        "/@fs/" +
        path
          .join(repositoryRoot, "packages/protocol/src/index.ts")
          .replaceAll("\\", "/")
          .replace(/^\//, ""),
    },
  );
  assert.equal(opened.route.tunnelId, tunnelId);
  return { key, kind, tunnelId, ...opened };
}

export async function closeShareCarrier(page, carrier) {
  await page.evaluate((key) => window.shareCarriers[key].close(), carrier.key);
}

function response(bytes) {
  const boundary = bytes.indexOf("\r\n\r\n");
  assert.ok(boundary >= 0, "complete HTTP response headers");
  const lines = bytes.subarray(0, boundary).toString("latin1").split("\r\n");
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines.shift())?.[1]);
  const headers = Object.fromEntries(
    lines.map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()];
    }),
  );
  let body = bytes.subarray(boundary + 4);
  if (headers["transfer-encoding"] === "chunked") {
    const chunks = [];
    for (;;) {
      const end = body.indexOf("\r\n");
      assert.ok(end >= 0);
      const size = parseInt(body.subarray(0, end).toString("ascii"), 16);
      assert.ok(Number.isFinite(size));
      if (!size) break;
      assert.ok(body.length >= end + 2 + size + 2);
      chunks.push(body.subarray(end + 2, end + 2 + size));
      body = body.subarray(end + 2 + size + 2);
    }
    body = Buffer.concat(chunks);
  } else if (headers["content-length"] !== undefined) {
    assert.equal(body.length, Number(headers["content-length"]));
  }
  return { status, headers, body };
}

async function exchange(page, carrier, request) {
  const base = {
    protocolVersion: 1,
    tunnelId: carrier.tunnelId,
    attachmentId: carrier.attachment.attachmentId,
    sourceEndpointId: carrier.route.sourceEndpointId,
    destinationEndpointId: carrier.route.destinationEndpointId,
    connectionId: randomUUID(),
  };
  const send = (header, payload = []) =>
    page.evaluate(
      ({ key, header, payload }) => {
        const state = window.shareCarriers[key];
        state.send(
          state.protocol.encodeTunnelDataPlaneFrame(
            header,
            new Uint8Array(payload),
          ),
        );
      },
      { key: carrier.key, header, payload: [...payload] },
    );
  await send({
    ...base,
    kind: "open",
    sequence: 0,
    initialCreditBytes: 1024 * 1024,
  });
  const frames = () =>
    page.evaluate(
      ({ key, id }) => ({
        closed: window.shareCarriers[key].closed,
        frames: window.shareCarriers[key].frames.filter(
          (f) => f.header.connectionId === id,
        ),
      }),
      { key: carrier.key, id: base.connectionId },
    );
  await eventually(frames, ({ closed, frames }) => {
    assert.equal(closed, null);
    assert.equal(
      frames.some((f) => f.header.kind === "rejected"),
      false,
      JSON.stringify(frames),
    );
    assert.ok(frames.some((f) => f.header.kind === "accepted"));
  });
  const sealed = sealTunnelDataFrame(
    carrier.configuration.dataProtection,
    {
      ...base,
      kind: "data",
      sequence: 1,
      direction: "source-to-destination",
    },
    request,
  );
  assert.equal(
    Buffer.from(sealed.payload).includes(request.subarray(0, 100)),
    false,
  );
  await send(sealed.header, sealed.payload);
  const completed = await eventually(frames, ({ closed, frames }) => {
    assert.equal(closed, null);
    assert.ok(
      frames.some(
        (f) => f.header.kind === "half-close" || f.header.kind === "close",
      ),
    );
    assert.ok(frames.some((f) => f.header.kind === "data"));
  });
  const bytes = Buffer.concat(
    completed.frames
      .filter((f) => f.header.kind === "data")
      .map((f) => {
        assert.ok(f.header.protection);
        return Buffer.from(
          openTunnelDataFrame(
            carrier.configuration.dataProtection,
            f.header,
            new Uint8Array(f.payload),
          ),
        );
      }),
  );
  await send({ ...base, kind: "close", sequence: 2, code: "normal" });
  return response(bytes);
}

const md5 = (text) => createHash("md5").update(text).digest("hex");
export async function webdav(
  page,
  carrier,
  share,
  method,
  suffix = "",
  body = Buffer.alloc(0),
  extra = {},
) {
  const uri = new URL(share.url).pathname + suffix;
  const request = (authorization) =>
    Buffer.concat([
      Buffer.from(
        `${method} ${uri} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Length: ${body.length}\r\n${Object.entries(
          extra,
        )
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join(
            "",
          )}${authorization ? "Authorization: " + authorization + "\r\n" : ""}\r\n`,
      ),
      body,
    ]);
  const challenge = await exchange(page, carrier, request());
  assert.equal(
    challenge.status,
    401,
    "worker requires HTTP Digest credentials",
  );
  const fields = Object.fromEntries(
    [
      ...challenge.headers["www-authenticate"].matchAll(/([a-z]+)="([^"]*)"/g),
    ].map((m) => [m[1], m[2]]),
  );
  assert.equal(fields.realm, share.realm);
  assert.equal(fields.qop, "auth");
  const nc = "00000001",
    cnonce = randomUUID();
  const digest = md5(
    `${md5(`${share.username}:${fields.realm}:${share.password}`)}:${fields.nonce}:${nc}:${cnonce}:auth:${md5(`${method}:${uri}`)}`,
  );
  const authorization = `Digest username="${share.username}", realm="${fields.realm}", nonce="${fields.nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${digest}", opaque="${fields.opaque}"`;
  return exchange(page, carrier, request(authorization));
}
