// Actual unchanged WorkerConnection, HTTP handlers and relay sockets. WorkerLink
// installation/renewal acknowledgments are controlled; no resource execution claim.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { WorkerConnection } from "../../cantrip_worker/src/transport.ts";
import { saveWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { workerLinkSessionSchema } from "../../packages/protocol/dist/index.js";
import { eventually } from "./coordinated-fixture-tools.mjs";
import { deadline } from "./live-sockets.mjs";
import { request, requestHeaders } from "./shared-runtime-fixture-tools.mjs";
import { verifyTenantSession } from "./shared-runtime-tenants.mjs";
const WebSocket = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("ws");
const generation = "55555555-5555-4555-8555-555555555555";

async function operation(peer, method, route, status) {
  return (await request(peer, method, route, undefined, status)).body;
}

async function relay(peer, session) {
  const url = new URL(
    `/api/worker-links/${session.sessionId}/connect`,
    peer.server.origin,
  );
  url.protocol = "ws:";
  url.searchParams.set("clientInstanceId", session.identity.clientInstanceId);
  url.searchParams.set("routeGeneration", String(session.routeGeneration));
  const socket = new WebSocket(url, {
    headers: requestHeaders(peer, { csrf: false }),
  });
  const closed = new Promise((resolve) =>
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    ),
  );
  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await deadline(opened, "shared WorkerLink relay upgrade");
  return { socket, closed };
}

export async function verifySharedWorkers(
  peers,
  directory,
  result,
  whileConnected,
) {
  const workers = [],
    sockets = [],
    controls = [];
  try {
    for (const [i, local] of peers.entries()) {
      const remote = peers[1 - i],
        workerId = "shared-enrolled-" + i;
      const bootstrap = local.records.get("bootstrap");
      const commands = [];
      let connected = 0;
      const config = {
        dataDirectory: path.join(directory, "worker-" + i),
        name: "Shared routing transport fixture",
        serverUrl: local.server.origin,
        enrollmentCode: null,
        replacement: null,
        token: local.records.get("enroll").credential,
        tokenSource: "persisted",
        workerId,
      };
      saveWorkerCredential({
        credential: config.token,
        dataDirectory: config.dataDirectory,
        serverUrl: config.serverUrl,
        workerId,
      });
      const worker = new WorkerConnection(
        config,
        async (command) => {
          if (!command.type.startsWith("worker-link.")) return null;
          commands.push(command);
          if (command.type === "worker-link.identity.resolve")
            return {
              serverId: bootstrap.server.id,
              ownerId: bootstrap.auth.currentUser.id,
              workerId,
              workerProcessGeneration: generation,
            };
          return { accepted: true };
        },
        undefined,
        undefined,
        undefined,
        1000,
        () => {
          connected++;
        },
        { connectionGeneration: generation },
      );
      workers.push(worker);
      worker.start();
      await eventually(
        () => connected,
        (v) => v,
        "actual shared worker ready",
      );
      // Observe the operation itself while the remote subscriber learns the
      // claim. A database heartbeat or Redis PING cannot prove this route ready.
      const opened = await eventually(
        async () => {
          const response = await fetch(
            remote.server.origin +
              `/api/workers/${workerId}/worker-link/sessions`,
            {
              method: "POST",
              headers: requestHeaders(remote, { json: true }),
              body: JSON.stringify({ clientInstanceId: "shared-control-" + i }),
              signal: AbortSignal.timeout(15000),
            },
          );
          const body = await response.json();
          assert.ok(
            response.status === 201 ||
              (response.status === 503 && body.error === "Worker is offline."),
            JSON.stringify({ status: response.status, body }),
          );
          return { status: response.status, body };
        },
        (v) => v.status === 201,
        "remote HTTP WorkerLink operation reaches actual worker",
      );
      const session = workerLinkSessionSchema.parse(opened.body);
      assert.equal(session.identity.ownerId, bootstrap.auth.currentUser.id);
      assert.equal(session.identity.workerId, workerId);
      assert.equal(session.identity.serverId, bootstrap.server.id);
      assert.equal(session.identity.workerProcessGeneration, generation);
      const base = `/api/worker-links/${session.sessionId}`;
      if (result.profile === "accounts") {
        const before = commands.length;
        await verifyTenantSession(peers, workerId, session, result);
        assert.equal(
          commands.length,
          before,
          "Foreign requests never dispatch a worker command",
        );
      }
      const renewalStarted = Date.now();
      const renewed = workerLinkSessionSchema.parse(
        await operation(local, "POST", base + "/renew", 200),
      );
      assert.deepEqual(renewed.identity, session.identity);
      assert.equal(renewed.sessionId, session.sessionId);
      assert.equal(
        renewed.lease.absoluteExpiresAt,
        session.lease.absoluteExpiresAt,
      );
      assert.ok(Date.parse(renewed.lease.expiresAt) > renewalStarted);
      assert.ok(
        Date.parse(renewed.lease.expiresAt) <= Date.now() + 120000 + 1000,
      );
      for (const peer of peers) sockets.push(await relay(peer, renewed));
      assert.equal(await operation(local, "DELETE", base, 204), null);
      for (const socket of sockets)
        assert.deepEqual(
          await deadline(socket.closed, "distributed actual relay revocation"),
          { code: 1008, reason: "WorkerLink session ended" },
        );
      sockets.length = 0;
      for (const type of [
        "worker-link.identity.resolve",
        "worker-link.session.install",
        "worker-link.session.renew",
        "worker-link.session.revoke",
      ])
        assert.ok(
          commands.some((c) => c.type === type),
          "Unchanged WorkerConnection acknowledged " + type,
        );
      result.cases.push(
        "worker " +
          i +
          " attached only locally receives remote HTTP install, cross-authority renewal/revocation and both real relay sockets close",
      );
      (result.workerCommands ??= []).push({
        worker: i,
        types: commands.map((c) => c.type),
      });
      controls.push({
        workerId,
        async verifyRecovered() {
          const response = await request(
            remote,
            "POST",
            `/api/workers/${workerId}/worker-link/sessions`,
            { clientInstanceId: "after-recovery-" + i },
            201,
          );
          const session = workerLinkSessionSchema.parse(response.body);
          assert.equal(session.identity.workerId, workerId);
          await operation(
            local,
            "DELETE",
            `/api/worker-links/${session.sessionId}`,
            204,
          );
          assert.equal(
            connected,
            1,
            "Actual worker transport remains on its original ready connection",
          );
        },
      });
    }
    if (whileConnected) await whileConnected(controls);
  } finally {
    for (const socket of sockets) socket.socket.terminate();
    for (const worker of workers) worker.close();
  }
}
