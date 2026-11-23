import { Duplex } from "node:stream";
import { createServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OsReverseForward } from "./reverse-forward.js";

let server: Server, port: number;
const sockets = new Set<Socket>(),
  streams: Duplex[] = [];
beforeEach(async () => {
  server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.destroy();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
function setup() {
  const stream = new Duplex({
    read() {},
    write(_bytes, _encoding, done) {
      done();
    },
  });
  streams.push(stream);
  return {
    stream,
    forward: new OsReverseForward(stream, { host: "127.0.0.1", port }),
  };
}
function frame(header: unknown, payload = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header)),
    prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(json.length);
  prefix.writeUInt32BE(payload.length, 4);
  return Buffer.concat([prefix, json, payload]);
}

describe("bounded guest listener protocol", () => {
  it.each([
    [{ type: "open", id: 1, credit: 65536, host: "another-host" }],
    [{ type: "open", id: 1, credit: 65537 }],
    [
      { type: "open", id: 1, credit: 65536 },
      { type: "open", id: 1, credit: 65536 },
    ],
    [
      { type: "open", id: 1, credit: 65536 },
      { type: "credit", id: 1, bytes: 1 },
    ],
    [{ type: "open", id: 0, credit: 65536 }],
    [{ type: "fin", id: 1, unexpected: true }],
    [{ type: ["close"], id: 1 }],
  ])(
    "closes the carrier on invalid or replayed frames: %j",
    async (...headers) => {
      const { stream, forward } = setup();
      stream.push(Buffer.concat(headers.map((header) => frame(header))));
      await forward.closed;
      expect(forward.error).toBeInstanceOf(Error);
      expect(stream.destroyed).toBe(true);
    },
  );
  it("rejects an oversized payload before accepting its bytes", async () => {
    const { stream, forward } = setup(),
      prefix = Buffer.alloc(8);
    prefix.writeUInt32BE(30);
    prefix.writeUInt32BE(65537, 4);
    stream.push(prefix);
    await forward.closed;
    expect(forward.error?.message).toMatch(/frame size/u);
  });
  it("does not accept an arbitrary runtime Host destination", () => {
    const { stream, forward } = setup();
    expect(
      () =>
        new OsReverseForward(stream, {
          host: "external.invalid" as "127.0.0.1",
          port,
        }),
    ).toThrow(/explicit Worker-host/u);
    forward.close();
  });
});
