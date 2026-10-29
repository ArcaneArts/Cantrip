// Controlled TCP forwarding for server compatibility tests. Identity verification
// and broker IO use the production native component; this is not Tauri IPC.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import {
  encodeTunnelDataPlaneFrame,
  decodeTunnelDataPlaneFrame,
} from "../../packages/protocol/dist/tunnel-data-plane.js";
import { NativeBrokerClient } from "./native-broker-client.mjs";
export async function directTerminalForwarder(binary, ticket) {
  const route = ticket.route,
    connections = new Map(),
    observations = [],
    sockets = new Set();
  let failure;
  const carrier = new NativeBrokerClient(binary, {
    ticket,
    onFrame(bytes) {
      try {
        const { header, payload } = decodeTunnelDataPlaneFrame(bytes);
        observations.push({
          direction: "from-worker",
          header,
          payloadBytes: payload.byteLength,
        });
        const connection = connections.get(header.connectionId);
        assert.ok(
          connection,
          "worker response belongs to the opened connection",
        );
        for (const [key, value] of Object.entries(route))
          assert.equal(header[key], value, "exact direct tunnel route binding");
        assert.equal(header.sequence, connection.received++);
        if (header.kind === "accepted") {
          connection.credit = header.initialCreditBytes;
          flush(connection);
        } else if (header.kind === "credit") {
          assert.equal(header.direction, "source-to-destination");
          connection.credit += header.bytes;
          flush(connection);
        } else if (header.kind === "data") {
          assert.equal(header.direction, "destination-to-source");
          assert.equal(
            header.protection,
            undefined,
            "terminal content has endpoint encryption inside WebSocket",
          );
          connection.socket.write(Buffer.from(payload), (error) => {
            if (error || connection.ended) return;
            send(connection, {
              kind: "credit",
              direction: "destination-to-source",
              bytes: payload.byteLength,
            });
          });
        } else if (header.kind === "half-close") {
          assert.equal(header.direction, "destination-to-source");
          connection.socket.end();
        } else if (["close", "error", "rejected"].includes(header.kind)) {
          connection.ended = true;
          connection.socket.destroy();
        } else
          throw new Error("Unexpected worker tunnel response: " + header.kind);
      } catch (error) {
        failure = error;
        for (const socket of sockets) socket.destroy();
      }
    },
  });
  function send(connection, extra, payload = new Uint8Array()) {
    if (carrier.exit || carrier.closed) {
      connection.ended = true;
      return;
    }
    if (connection.ended) return;
    const header = {
      protocolVersion: 1,
      ...route,
      connectionId: connection.id,
      sequence: connection.sent++,
      ...extra,
    };
    observations.push({
      direction: "to-worker",
      header,
      payloadBytes: payload.byteLength,
    });
    carrier.send(encodeTunnelDataPlaneFrame(header, payload));
  }
  function flush(connection) {
    while (connection.queue.length && connection.credit > 0) {
      const bytes = connection.queue[0],
        size = Math.min(bytes.length, connection.credit, 65536);
      const chunk = bytes.subarray(0, size);
      connection.credit -= size;
      if (size === bytes.length) connection.queue.shift();
      else connection.queue[0] = bytes.subarray(size);
      send(
        connection,
        { kind: "data", direction: "source-to-destination" },
        chunk,
      );
    }
    if (!connection.queue.length) {
      if (connection.halfClosed && !connection.halfSent) {
        connection.halfSent = true;
        send(connection, {
          kind: "half-close",
          direction: "source-to-destination",
        });
      } else if (!connection.halfClosed) connection.socket.resume();
    }
  }
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.pause();
    const connection = {
      id: randomUUID(),
      socket,
      sent: 0,
      received: 0,
      credit: 0,
      queue: [],
      halfClosed: false,
      halfSent: false,
      ended: false,
    };
    connections.set(connection.id, connection);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", (bytes) => {
      socket.pause();
      connection.queue.push(bytes);
      flush(connection);
    });
    socket.once("end", () => {
      connection.halfClosed = true;
      flush(connection);
    });
    send(connection, { kind: "open", initialCreditBytes: 1024 * 1024 });
  });
  carrier.exited.then(
    () => {
      for (const socket of sockets) socket.destroy();
    },
    (error) => {
      failure = error;
      for (const socket of sockets) socket.destroy();
    },
  );
  try {
    const verified = await carrier.ready();
    assert.equal(verified.event, "verified", JSON.stringify(verified));
    assert.equal(verified.workerId, ticket.binding.workerId);
    assert.equal(verified.brokerInstanceId, ticket.broker.instanceId);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return {
      port: server.address().port,
      carrier,
      observations,
      verified,
      check() {
        if (failure) throw failure;
        if (carrier.errors.length) throw carrier.errors[0];
      },
      async close() {
        for (const connection of connections.values()) connection.ended = true;
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        await carrier.close();
      },
    };
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await carrier.close().catch(() => {});
    throw error;
  }
}
