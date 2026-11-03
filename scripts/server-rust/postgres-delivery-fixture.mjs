// A transparent proxy for disposable, plaintext loopback PostgreSQL fixtures.
// It holds real frames at a chosen delivery boundary; it never invents events.
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";

export async function postgresDeliveryFixture(connection) {
  const target = new URL(connection);
  assert.ok(["127.0.0.1", "localhost"].includes(target.hostname));
  const sockets = new Set();
  const peers = new Set();
  let gate;
  const observations = [];
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    sockets.add(client);
    sockets.add(upstream);
    const peer = { client, held: [], holding: false };
    peers.add(peer);
    let frontend = Buffer.alloc(0),
      backend = Buffer.alloc(0);
    let startup = true,
      sslResponse = false;
    const statements = new Map();
    const inspectQuery = (query) => {
      if (gate && /insert\s+into\s+"?agent_interaction_requests"?/i.test(query))
        peer.interactionWrite = gate;
      if (
        gate?.mode === "commit-response" &&
        peer.interactionWrite === gate &&
        /^commit\s*;?$/i.test(query.trim())
      ) {
        assert.equal(
          gate.commitPeer,
          undefined,
          "one gated transaction commit",
        );
        gate.commitPeer = peer;
        peer.holding = true;
        observations.push({ boundary: "commit-sent" });
      }
    };
    client.on("data", (data) => {
      frontend = Buffer.concat([frontend, data]);
      while (frontend.length >= (startup ? 8 : 5)) {
        const length = frontend.readUInt32BE(startup ? 0 : 1);
        const total = length + (startup ? 0 : 1);
        if (frontend.length < total) break;
        const frame = frontend.subarray(0, total);
        frontend = frontend.subarray(total);
        if (startup) {
          if (length === 8 && frame.readUInt32BE(4) === 80877103)
            sslResponse = true;
          else startup = false;
        } else if (frame[0] === 81)
          inspectQuery(frame.subarray(5, -1).toString());
        else if (frame[0] === 80) {
          const nameEnd = frame.indexOf(0, 5),
            start = nameEnd + 1;
          statements.set(
            frame.subarray(5, nameEnd).toString(),
            frame.subarray(start, frame.indexOf(0, start)).toString(),
          );
        } else if (frame[0] === 66) {
          const start = frame.indexOf(0, 5) + 1;
          const statement = frame
            .subarray(start, frame.indexOf(0, start))
            .toString();
          inspectQuery(statements.get(statement) ?? "");
        }
      }
      upstream.write(data);
    });
    upstream.on("data", (data) => {
      backend = Buffer.concat([backend, data]);
      if (sslResponse && backend.length) {
        assert.equal(backend[0], 78, "fixture PostgreSQL uses plaintext");
        client.write(backend.subarray(0, 1));
        backend = backend.subarray(1);
        sslResponse = false;
      }
      while (backend.length >= 5) {
        const total = backend.readUInt32BE(1) + 1;
        if (backend.length < total) break;
        const frame = backend.subarray(0, total);
        backend = backend.subarray(total);
        if (gate?.commitPeer === peer)
          observations.push({
            boundary: "commit-result-frame",
            type: String.fromCharCode(frame[0]),
          });
        if (frame[0] === 65) {
          const channel = frame.subarray(9, frame.indexOf(0, 9)).toString();
          if (channel === "cantrip_project_alerts" && gate) {
            observations.push({
              boundary: "alert-notification",
              held: gate.mode === "notification",
            });
            if (gate.mode === "notification") peer.holding = true;
          }
        }
        if (peer.holding) peer.held.push(Buffer.from(frame));
        else client.write(frame);
      }
    });
    for (const [socket, other] of [
      [client, upstream],
      [upstream, client],
    ]) {
      socket.on("error", () => other.destroy());
      socket.on("close", () => {
        sockets.delete(socket);
        other.destroy();
      });
    }
    client.on("close", () => peers.delete(peer));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const url = new URL(connection);
  url.hostname = "127.0.0.1";
  url.port = String(address.port);
  return {
    url: url.href,
    observations,
    arm(mode) {
      assert.equal(gate, undefined, "previous delivery gate released");
      assert.ok(["commit-response", "notification"].includes(mode));
      gate = { mode };
    },
    release() {
      if (!gate) return 0;
      let frames = 0;
      for (const peer of peers) {
        if (peer.held.length) peer.client.write(Buffer.concat(peer.held));
        frames += peer.held.length;
        peer.held = [];
        peer.holding = false;
      }
      observations.push({ boundary: "released", mode: gate?.mode, frames });
      gate = undefined;
      return frames;
    },
    async close() {
      this.release();
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
