// Delay an actual SELECT 1 CommandComplete, retaining the real result and wire
// order. Frontend execution tracking distinguishes it from background SELECTs.
import net from "node:net";
import { once } from "node:events";
import assert from "node:assert/strict";

export async function databaseHealthProxy(upstream, { onError, onProbe } = {}) {
  const target = new URL(upstream),
    sockets = new Set();
  let armed, held;
  const release = () => {
    if (held) {
      const current = held;
      held = undefined;
      for (const frame of current.frames) current.client.write(frame);
    }
  };
  const server = net.createServer((client) => {
    const remote = net.connect({
      host: target.hostname,
      port: Number(target.port || 5432),
    });
    sockets.add(client);
    sockets.add(remote);
    let front = Buffer.alloc(0),
      back = Buffer.alloc(0),
      startup = true;
    const statements = new Map(),
      portals = new Map(),
      executions = [];
    const close = () => {
      sockets.delete(client);
      sockets.delete(remote);
      client.destroy();
      remote.destroy();
    };
    client.on("error", close);
    remote.on("error", close);
    client.on("close", close);
    remote.on("end", () => client.end());
    remote.on("close", () => {
      sockets.delete(remote);
      client.end();
    });
    client.pipe(remote);
    client.on("data", (bytes) => {
      front = Buffer.concat([front, bytes]);
      if (startup) {
        if (front.length < 4 || front.length < front.readUInt32BE(0)) return;
        front = front.subarray(front.readUInt32BE(0));
        startup = false;
      }
      while (front.length >= 5) {
        const size = front.readUInt32BE(1) + 1;
        if (front.length < size) break;
        const frame = front.subarray(0, size);
        front = front.subarray(size);
        const fields = frame.subarray(5).toString().split("\0");
        if (frame[0] === 80) statements.set(fields[0], fields[1]);
        if (frame[0] === 66) portals.set(fields[0], statements.get(fields[1]));
        if (frame[0] === 81) executions.push(fields[0]);
        if (frame[0] === 69) executions.push(portals.get(fields[0]));
      }
    });
    remote.on("data", (bytes) => {
      back = Buffer.concat([back, bytes]);
      while (back.length >= 5) {
        const size = back.readUInt32BE(1) + 1;
        if (back.length < size) break;
        const frame = back.subarray(0, size);
        back = back.subarray(size);
        if (frame[0] === 69) {
          const fields = frame.subarray(5).toString().split("\0");
          onError?.({
            code: fields.find((field) => field.startsWith("C"))?.slice(1),
            severity: fields.find((field) => field.startsWith("S"))?.slice(1),
            actualBackend: true,
          });
        }
        const sql = frame[0] === 67 ? executions.shift() : undefined;
        if (frame[0] === 67 && /^select\s+1\s*;?\s*$/i.test(sql ?? ""))
          onProbe?.({
            actualSql: sql,
            actualCommandComplete: frame.subarray(5).toString(),
            actualBackend: true,
            at: Date.now(),
          });
        if (
          armed &&
          frame[0] === 67 &&
          /^select\s+1\s*;?\s*$/i.test(sql ?? "")
        ) {
          assert.equal(frame.subarray(5).toString(), "SELECT 1\0");
          held = { client, frames: [] };
          const current = armed;
          armed = undefined;
          current.resolve({
            actualSql: sql,
            actualCommandComplete: frame.subarray(5).toString(),
            realBackend: true,
            acknowledgementDropped: current.drop,
          });
          if (current.drop) {
            held = undefined;
            close();
            return;
          }
        }
        if (frame[0] === 90) executions.length = 0;
        if (held?.client === client) held.frames.push(frame);
        else client.write(frame);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = new URL(upstream);
  url.hostname = "127.0.0.1";
  url.port = String(server.address().port);
  url.searchParams.set("sslmode", "disable");
  return {
    url: url.href,
    arm(drop = false) {
      assert.ok(!armed && !held);
      const pending = Promise.withResolvers();
      armed = { ...pending, drop };
      return { observed: pending.promise, release };
    },
    async close() {
      release();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
