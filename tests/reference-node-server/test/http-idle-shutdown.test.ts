import { once } from "node:events";
import { get } from "node:http";
import { connect, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createApplicationServer } from "../src/app/http/server.js";
import { readServerConfig } from "../src/config.js";

for (const partial of [false, true])
  it(`closes an unadmitted ${partial ? "partial-header" : "speculative"} connection`, async () => {
    const { app } = createApplicationServer(readServerConfig(), false);
    let socket: Socket | undefined, closing: Promise<void> | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected TCP listener");
      socket = connect(address.port, "127.0.0.1");
      socket.on("error", () => {});
      await once(socket, "connect");
      if (partial) {
        socket.write("GET / HTTP/1.1\r\nHost:");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      closing = app.close();
      expect(
        await Promise.race([
          closing.then(() => true),
          delay(1000).then(() => false),
        ]),
      ).toBe(true);
    } finally {
      socket?.destroy();
      await closing;
      await app.close();
    }
  });

it("retains an admitted request while closing speculative connections", async () => {
  const { app } = createApplicationServer(readServerConfig(), false);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  app.get("/held", async () => {
    entered();
    await held;
    return { committed: true };
  });
  let idle: Socket | undefined, closing: Promise<void> | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP listener");
    const response = new Promise<string>((resolve, reject) => {
      const request = get(
        `http://127.0.0.1:${address.port}/held`,
        { agent: false },
        (response) => {
          let body = "";
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () => resolve(body));
        },
      );
      request.on("error", reject);
    });
    await admitted;
    idle = connect(address.port, "127.0.0.1");
    idle.on("error", () => {});
    await once(idle, "connect");
    let closed = false;
    closing = app.close().then(() => {
      closed = true;
    });
    expect(
      await Promise.race([
        new Promise<boolean>((resolve) =>
          idle!.once("close", () => resolve(true)),
        ),
        delay(1000).then(() => false),
      ]),
    ).toBe(true);
    expect(closed).toBe(false);
    release();
    expect(JSON.parse(await response)).toEqual({ committed: true });
    await closing;
  } finally {
    release();
    idle?.destroy();
    await closing;
    await app.close();
  }
});
it("leaves upgraded transports to their registered lifecycle owner", async () => {
  const { app } = createApplicationServer(readServerConfig(), false);
  let owned: import("node:stream").Duplex | undefined, admitted!: () => void;
  const upgraded = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  app.server.on("upgrade", (_request, socket) => {
    owned = socket;
    socket.on("error", () => {});
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n",
    );
    admitted();
  });
  app.addHook("preClose", async () => {
    expect(owned?.destroyed).toBe(false);
    owned?.end();
  });
  let client: Socket | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP listener");
    client = connect(address.port, "127.0.0.1");
    client.on("error", () => {});
    await once(client, "connect");
    client.resume();
    client.write(
      "GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n",
    );
    await upgraded;
    await app.close();
  } finally {
    client?.destroy();
    owned?.destroy();
    await app.close();
  }
});
