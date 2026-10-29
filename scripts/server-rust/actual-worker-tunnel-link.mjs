// Real loopback TCP through the unchanged worker and production browser
// WorkerLink adapter. The controlled source endpoint uses the production tunnel
// AES implementation; desktop Tauri forwarding/IPC remains separate acceptance.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { repositoryRoot } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { literal, json } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";
import {
  sealTunnelDataFrame,
  openTunnelDataFrame,
} from "../../cantrip_worker/src/tunnel-data-protection.ts";
const hash = (v) => createHash("sha256").update(v).digest("hex");
export async function prepareTunnelLink(page, projectId, workerId) {
  const token = "private-tcp-tunnel-" + randomUUID(),
    plaintext = Buffer.from(token + ":" + "x".repeat(40000)),
    reply = Buffer.concat([
      Buffer.from("authenticated-worker-reply:"),
      plaintext,
    ]);
  const sockets = new Set(),
    received = [];
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const chunks = [];
    socket.on("data", (bytes) => chunks.push(Buffer.from(bytes)));
    socket.on("error", () => {});
    socket.on("end", () => {
      const request = Buffer.concat(chunks);
      received.push({ bytes: request.length, sha256: hash(request) });
      socket.end(
        Buffer.concat([Buffer.from("authenticated-worker-reply:"), request]),
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const id = randomUUID(),
    attachmentId = randomUUID(),
    port = server.address().port;
  try {
    const prepared = await page.evaluate(
      async ({ id, workerId, port }) => {
        const crypto = await import("/src/lib/tunnel-content-encryption.ts");
        const dataProtection = crypto.createTunnelDataProtection();
        return {
          owner: window.folderIdentity.ownerId,
          dataProtection,
          protectedRecord: await crypto.protectTunnelContentRecord({
            tunnelId: id,
            workerId,
            operationId: globalThis.crypto.randomUUID(),
            revision: 1,
            content: {
              name: "Private TCP acceptance",
              description: null,
              source: { kind: "desktop-loopback" },
              destination: {
                kind: "worker-tcp",
                workerId,
                host: "127.0.0.1",
                port,
              },
              dataProtection,
            },
          }),
        };
      },
      { id, workerId, port },
    );
    return {
      id,
      attachmentId,
      projectId,
      workerId,
      ...prepared,
      plaintext,
      reply,
      received,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      },
    };
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
}
export async function seedTunnelLink(fixture, root, executable, tunnel) {
  const repo = await repositoryFixture({
    kind: fixture.kind,
    root: path.join(root, fixture.name),
    executable,
    databaseMode: fixture.databaseMode,
    databaseUrl: fixture.environment.DATABASE_URL,
  });
  try {
    await repo.seed(
      `INSERT INTO tunnels(id,owner_id,project_id,origin,management,protocol_hint,source_kind,destination_kind,destination_worker_id,protected_content,protected_operation_id,protected_revision) VALUES(${literal(tunnel.id)},${literal(tunnel.owner)},${literal(tunnel.projectId)},'user','user-managed','tcp','desktop-loopback','worker-tcp',${literal(tunnel.workerId)},${json(tunnel.protectedRecord.protectedContent)},${literal(tunnel.protectedRecord.operationId)},1)`,
    );
    await repo.seed(
      `INSERT INTO tunnel_attachments(id,tunnel_id,kind,client_id,secret_hash,status,secret_expires_at,expires_at) VALUES(${literal(tunnel.attachmentId)},${literal(tunnel.id)},'desktop-loopback','actual-tcp-client','actual-tcp-secret-hash','offline','2029-01-01','2030-01-01')`,
    );
  } finally {
    await repo.close();
  }
}
export async function actualWorkerTunnelLink({
  page,
  tunnel,
  result,
  route = "relay",
}) {
  const responses = [];
  result.tunnelLink = { completed: false, responses };
  const observe = (response) => {
    const pathname = new URL(response.url()).pathname;
    if (
      pathname.includes("/tunnel-attachments/") ||
      pathname.includes("/grants/")
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
      async ({ workerId, attachmentId, schemaUrl }) => {
        const transport = await import("/src/lib/tunnel-worker-link.ts");
        window.actualTunnelProtocol = await import(schemaUrl);
        window.actualTunnelFrames = [];
        window.actualTunnelClosed = null;
        window.actualTunnelLink = await transport.openTunnelWorkerLink({
          workerId,
          attachmentId,
          onClose: (code) => {
            window.actualTunnelClosed = code;
          },
          onFrame: (bytes) => {
            const { header, payload } =
              window.actualTunnelProtocol.decodeTunnelDataPlaneFrame(bytes);
            window.actualTunnelFrames.push({
              header,
              payload: Array.from(payload),
            });
          },
        });
        window.actualTunnelLink.activate();
        return {
          route: window.actualTunnelLink.route,
          routeBinding: window.actualTunnelLink.tunnelRoute,
        };
      },
      {
        workerId: tunnel.workerId,
        attachmentId: tunnel.attachmentId,
        schemaUrl:
          "/@fs/" +
          path
            .join(repositoryRoot, "packages/protocol/src/tunnel-data-plane.ts")
            .replaceAll("\\", "/")
            .replace(/^\//, ""),
      },
    );
    assert.equal(opened.route, route);
    assert.equal(opened.routeBinding.target.kind, "protected-tunnel");
    assert.deepEqual(
      opened.routeBinding.target.protectedRecord,
      tunnel.protectedRecord,
    );
    const base = {
      protocolVersion: 1,
      tunnelId: tunnel.id,
      attachmentId: tunnel.attachmentId,
      sourceEndpointId: opened.routeBinding.sourceEndpointId,
      destinationEndpointId: opened.routeBinding.destinationEndpointId,
      connectionId: randomUUID(),
    };
    const send = async (header, payload = []) =>
      page.evaluate(
        ({ header, payload }) => {
          const bytes = window.actualTunnelProtocol.encodeTunnelDataPlaneFrame(
            header,
            new Uint8Array(payload),
          );
          if (!window.actualTunnelLink.send(bytes))
            throw new Error("Actual tunnel frame was not admitted");
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
          closed: window.actualTunnelClosed,
          frames: window.actualTunnelFrames,
        })),
      (state) => {
        assert.equal(state.closed, null);
        assert.equal(
          state.frames.some((f) => f.header.kind === "rejected"),
          false,
          JSON.stringify(state.frames),
        );
        assert.ok(state.frames.some((f) => f.header.kind === "accepted"));
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
    assert.equal(
      Buffer.from(protectedFrame.payload).includes(tunnel.plaintext),
      false,
    );
    await send(protectedFrame.header, protectedFrame.payload);
    await send({
      ...base,
      kind: "half-close",
      sequence: 2,
      direction: "source-to-destination",
    });
    const frames = await eventually(
      () => page.evaluate(() => window.actualTunnelFrames),
      (frames) => {
        const data = frames.filter((f) => f.header.kind === "data");
        const opened = Buffer.concat(
          data.map((f) =>
            Buffer.from(
              openTunnelDataFrame(
                tunnel.dataProtection,
                f.header,
                new Uint8Array(f.payload),
              ),
            ),
          ),
        );
        assert.deepEqual(opened, tunnel.reply);
        assert.ok(
          frames.some(
            (f) => f.header.kind === "half-close" || f.header.kind === "close",
          ),
        );
      },
    );
    assert.deepEqual(tunnel.received, [
      { bytes: tunnel.plaintext.length, sha256: hash(tunnel.plaintext) },
    ]);
    for (const frame of frames.filter((f) => f.header.kind === "data")) {
      assert.ok(frame.header.protection);
      assert.equal(frame.header.direction, "destination-to-source");
      assert.equal(
        Buffer.from(frame.payload).includes(tunnel.plaintext.subarray(0, 100)),
        false,
      );
    }
    await page.evaluate(() => window.actualTunnelLink.close());
    await eventually(
      () => responses,
      (items) =>
        assert.ok(
          items.some(
            (r) =>
              r.pathname.includes("/grants/") &&
              r.method === "DELETE" &&
              r.status === 204,
          ),
        ),
    );
    result.tunnelLink = {
      completed: true,
      route,
      bytesToWorker: tunnel.plaintext.length,
      bytesFromWorker: tunnel.reply.length,
      requestSha256: hash(tunnel.plaintext),
      replySha256: hash(tunnel.reply),
      encryptedFrames: frames.filter((f) => f.header.kind === "data").length,
      halfClose: true,
      grantReleased: true,
      responses,
    };
    result.steps.push(
      "production browser tunnel WorkerLink adapter and full unchanged worker carry authenticated ciphertext to a real TCP target, preserve half-close, return encrypted reply and release grant",
    );
  } finally {
    result.tunnelLink.lastFrames = await page
      .evaluate(() =>
        window.actualTunnelFrames?.map((f) => ({
          kind: f.header.kind,
          sequence: f.header.sequence,
          bytes: f.payload.length,
        })),
      )
      .catch(() => null);
    await page.evaluate(() => window.actualTunnelLink?.close()).catch(() => {});
    page.off("response", observe);
  }
}
