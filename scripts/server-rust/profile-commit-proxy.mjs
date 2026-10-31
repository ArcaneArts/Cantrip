// Hold the real backend's COMMIT acknowledgement after PostgreSQL has already
// committed. This exercises the actual lost-acknowledgement recovery boundary.
import net from "node:net";
import { once } from "node:events";
import assert from "node:assert/strict";

export async function profileCommitProxy(upstream) {
  const target = new URL(upstream),
    sockets = new Set();
  let armed = true,
    resolveCommit;
  const committed = new Promise((resolve) => (resolveCommit = resolve));
  const server = net.createServer((client) => {
    const remote = net.connect({
      host: target.hostname,
      port: Number(target.port || 5432),
    });
    sockets.add(client);
    sockets.add(remote);
    let pending = Buffer.alloc(0),
      held = false;
    client.pipe(remote);
    const close = () => {
      sockets.delete(client);
      sockets.delete(remote);
      client.destroy();
      remote.destroy();
    };
    client.on("error", close);
    remote.on("error", close);
    client.on("close", close);
    remote.on("close", close);
    remote.on("data", (bytes) => {
      if (held) return;
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1);
        assert.ok(length >= 4 && length < 256 * 1024 * 1024);
        if (pending.length < length + 1) break;
        const frame = pending.subarray(0, length + 1);
        pending = pending.subarray(length + 1);
        if (
          armed &&
          frame[0] === 67 &&
          frame.subarray(5).equals(Buffer.from("COMMIT\0"))
        ) {
          armed = false;
          held = true;
          resolveCommit({
            actualCommandComplete: frame.subarray(5).toString(),
            backendCommitted: true,
          });
          return;
        }
        client.write(frame);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const exposed = new URL(upstream);
  exposed.hostname = "127.0.0.1";
  exposed.port = String(server.address().port);
  exposed.searchParams.set("sslmode", "disable");
  return {
    url: exposed.href,
    committed,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
