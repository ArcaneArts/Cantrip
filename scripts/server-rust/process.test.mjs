import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "./process.mjs";

test("startup failure retains both child output streams", async () => {
  await assert.rejects(
    startServer(process.execPath, [
      "-e",
      `console.log("owned startup progress");
       console.error("owned startup failure");
       process.exitCode = 23;`,
    ]),
    (error) => {
      assert.match(error.message, /Server exited before listening \(23\)/);
      assert.match(error.message, /owned startup failure/);
      assert.match(error.message, /owned startup progress/);
      return true;
    },
  );
});

test("startup output preserves actual HTTP readiness and graceful shutdown", async () => {
  const server = await startServer(process.execPath, [
    "-e",
    `const http = require("node:http");
     console.log("owned startup progress before binding");
     const server = http.createServer((_request, response) => response.end("ready"));
     server.listen(0, "127.0.0.1", () => {
       console.log(JSON.stringify({
         event: "server.listening",
         origin: "http://127.0.0.1:" + server.address().port,
       }));
     });
     process.stdin.resume();
     process.stdin.on("end", () => server.close());`,
  ]);
  try {
    const response = await fetch(server.origin);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ready");
    assert.equal(
      server.events.filter((event) => event.event === "server.listening")
        .length,
      1,
    );
  } finally {
    await server.close();
  }
});
