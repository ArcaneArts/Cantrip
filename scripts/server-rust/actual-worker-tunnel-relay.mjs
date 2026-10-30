// Existing browser API/crypto, production legacy CTTN carrier and the full
// unchanged worker, with a real loopback TCP target and authenticated reply.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { repositoryRoot } from "./build.mjs";
import { eventually } from "./full-worker.mjs";
import {
  sealTunnelDataFrame,
  openTunnelDataFrame,
} from "../../cantrip_worker/src/tunnel-data-protection.ts";
const hash = (value) => createHash("sha256").update(value).digest("hex");
export async function actualWorkerTunnelRelay({
  page,
  tunnel,
  result,
  fixture,
}) {
  const responses = [],
    before = tunnel.received.length;
  result.tunnelRelay = {
    completed: false,
    responses,
    peerEvents: tunnel.peerEvents,
  };
  const observe = (response) => {
    const pathname = new URL(response.url()).pathname;
    if (
      pathname.includes("/tunnel-attachments/") ||
      pathname.endsWith("/attachments")
    )
      responses.push({
        pathname,
        method: response.request().method(),
        status: response.status(),
      });
  };
  page.on("response", observe);
  try {
    const opened = await page.evaluate(
      async ({ tunnelId, schemaUrl }) => {
        const api = await import("/src/lib/api/tunnels.ts");
        const { getActiveServerUrl } =
          await import("/src/lib/server-connections.ts");
        window.actualLegacyTunnelProtocol = await import(schemaUrl);
        const configuration =
          await api.getTunnelTransportConfiguration(tunnelId);
        const attachment = await api.createTunnelAttachment(tunnelId, {
          clientId: "actual-tcp-relay-client",
        });
        window.actualLegacyTunnelAttachment = attachment;
        window.actualLegacyTunnelFrames = [];
        window.actualLegacyTunnelClosed = null;
        const socket = new WebSocket(
          getActiveServerUrl().replace(/^http/, "ws") + attachment.connectPath,
          ["cantrip-tunnel-v1." + attachment.secret],
        );
        socket.binaryType = "arraybuffer";
        window.actualLegacyTunnelSocket = socket;
        const ready = await new Promise((resolve, reject) => {
          socket.onopen = () =>
            socket.send(
              JSON.stringify({
                type: "initialize",
                clientId: "actual-tcp-relay-client",
              }),
            );
          socket.onclose = (event) => {
            window.actualLegacyTunnelClosed = {
              code: event.code,
              reason: event.reason,
            };
            reject(
              new Error(
                "Legacy tunnel closed before ready: " +
                  event.code +
                  " " +
                  event.reason,
              ),
            );
          };
          socket.onerror = () =>
            reject(new Error("Legacy tunnel socket failed"));
          socket.onmessage = (event) => {
            try {
              if (typeof event.data === "string")
                resolve(
                  window.actualLegacyTunnelProtocol.tunnelAttachmentReadySchema.parse(
                    JSON.parse(event.data),
                  ),
                );
              else {
                const bytes = new Uint8Array(event.data),
                  frame =
                    window.actualLegacyTunnelProtocol.decodeTunnelDataPlaneFrame(
                      bytes,
                    );
                window.actualLegacyTunnelFrames.push({
                  header: frame.header,
                  payload: Array.from(frame.payload),
                  encodedBytes: bytes.length,
                });
              }
            } catch (error) {
              window.actualLegacyTunnelError = String(error);
              reject(error);
            }
          };
        });
        return { attachment, ready, configuration };
      },
      {
        tunnelId: tunnel.id,
        schemaUrl:
          "/@fs/" +
          path
            .join(repositoryRoot, "packages/protocol/src/index.ts")
            .replaceAll("\\", "/")
            .replace(/^\//, ""),
      },
    );
    assert.equal(opened.ready.type, "ready");
    assert.equal(opened.ready.attachmentId, opened.attachment.attachmentId);
    assert.equal(opened.ready.tunnelId, tunnel.id);
    assert.equal(
      opened.ready.sourceEndpointId,
      `desktop:actual-tcp-relay-client:${opened.attachment.attachmentId}`,
    );
    assert.equal(
      opened.ready.destinationEndpointId,
      `worker:${tunnel.workerId}`,
    );
    assert.deepEqual(
      opened.configuration.dataProtection,
      tunnel.dataProtection,
    );
    const base = {
      protocolVersion: 1,
      tunnelId: tunnel.id,
      attachmentId: opened.attachment.attachmentId,
      sourceEndpointId: opened.ready.sourceEndpointId,
      destinationEndpointId: opened.ready.destinationEndpointId,
      connectionId: randomUUID(),
    };
    const send = (header, payload = []) =>
      page.evaluate(
        ({ header, payload }) => {
          const socket = window.actualLegacyTunnelSocket;
          if (socket.readyState !== WebSocket.OPEN)
            throw new Error("Legacy tunnel carrier is closed");
          socket.send(
            window.actualLegacyTunnelProtocol.encodeTunnelDataPlaneFrame(
              header,
              new Uint8Array(payload),
            ),
          );
        },
        { header, payload: Array.from(payload) },
      );
    await send({
      ...base,
      kind: "open",
      sequence: 0,
      initialCreditBytes: 1024 * 1024,
    });
    await eventually(
      () =>
        page.evaluate(() => ({
          closed: window.actualLegacyTunnelClosed,
          error: window.actualLegacyTunnelError,
          frames: window.actualLegacyTunnelFrames,
        })),
      (state) => {
        assert.equal(state.closed, null);
        assert.equal(state.error, undefined);
        assert.ok(
          !state.frames.some((frame) => frame.header.kind === "rejected"),
          JSON.stringify(state.frames),
        );
        assert.ok(
          state.frames.some((frame) => frame.header.kind === "accepted"),
        );
      },
    );
    const protectedFrame = sealTunnelDataFrame(
      tunnel.dataProtection,
      {
        ...base,
        kind: "data",
        sequence: 1,
        direction: "source-to-destination",
      },
      tunnel.plaintext,
    );
    assert.ok(!Buffer.from(protectedFrame.payload).includes(tunnel.plaintext));
    await send(protectedFrame.header, protectedFrame.payload);
    await send({
      ...base,
      kind: "half-close",
      sequence: 2,
      direction: "source-to-destination",
    });
    const frames = await eventually(
      () => page.evaluate(() => window.actualLegacyTunnelFrames),
      (frames) => {
        const plain = Buffer.concat(
          frames
            .filter((frame) => frame.header.kind === "data")
            .map((frame) =>
              Buffer.from(
                openTunnelDataFrame(
                  tunnel.dataProtection,
                  frame.header,
                  new Uint8Array(frame.payload),
                ),
              ),
            ),
        );
        assert.equal(
          plain.length,
          tunnel.reply.length,
          "complete authenticated legacy reply length",
        );
        assert.deepEqual(plain, tunnel.reply);
        assert.ok(
          frames.some(
            (frame) =>
              frame.header.kind === "half-close" ||
              frame.header.kind === "close",
          ),
        );
      },
    );
    assert.deepEqual(tunnel.received.slice(before), [
      { bytes: tunnel.plaintext.length, sha256: hash(tunnel.plaintext) },
    ]);
    for (const frame of frames.filter(
      (frame) => frame.header.kind === "data",
    )) {
      assert.ok(frame.header.protection);
      assert.equal(frame.header.direction, "destination-to-source");
      assert.ok(
        !Buffer.from(frame.payload).includes(tunnel.plaintext.subarray(0, 100)),
      );
    }
    await page.evaluate(async () => {
      await (
        await import("/src/lib/api/tunnels.ts")
      ).deleteTunnelAttachment(
        window.actualLegacyTunnelAttachment.attachmentId,
      );
    });
    const closed = await eventually(
      () => page.evaluate(() => window.actualLegacyTunnelClosed),
      (closed) =>
        assert.deepEqual(closed, { code: 1008, reason: "Attachment revoked" }),
    );
    assert.ok(
      responses.some(
        (response) => response.method === "POST" && response.status === 201,
      ),
    );
    assert.ok(
      responses.some(
        (response) => response.method === "DELETE" && response.status === 204,
      ),
    );
    assert.ok(
      !fixture.server
        .diagnostics()
        .includes(tunnel.plaintext.subarray(0, 100).toString()),
    );
    result.tunnelRelay = {
      completed: true,
      transport: "legacy-cttn-websocket",
      clientApi: true,
      unchangedWorker: true,
      bytesToWorker: tunnel.plaintext.length,
      bytesFromWorker: tunnel.reply.length,
      requestSha256: hash(tunnel.plaintext),
      replySha256: hash(tunnel.reply),
      encryptedFrames: frames.filter((frame) => frame.header.kind === "data")
        .length,
      halfClose: true,
      attachmentRevoked: true,
      closed,
      responses,
      peerEvents: tunnel.peerEvents,
    };
    result.steps.push(
      "existing browser attachment API and full unchanged worker carry authenticated legacy CTTN ciphertext through the server to a real TCP target, preserve half-close, return an encrypted reply and revoke the attachment",
    );
  } finally {
    result.tunnelRelay.lastFrames = await page
      .evaluate(() =>
        window.actualLegacyTunnelFrames?.map((frame) => ({
          kind: frame.header.kind,
          sequence: frame.header.sequence,
          bytes: frame.payload.length,
        })),
      )
      .catch(() => null);
    await page
      .evaluate(() => window.actualLegacyTunnelSocket?.close())
      .catch(() => {});
    page.off("response", observe);
  }
}
