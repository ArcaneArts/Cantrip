import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startPackagedNodeServer } from "./packaged-node-fixture.mjs";

for (const platform of [process.platform, "win32"]) {
  test(`packaged Node fixture completes its real shutdown handler on ${platform}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip reference 😀 "));
    let server;
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
      await writeFile(
        path.join(root, "dist/index.js"),
        `import { createServer } from "node:http";
const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ database: { engine: "fixture" } }));
});
server.listen(Number(process.env.CANTRIP_SERVER_PORT), "127.0.0.1");
process.once("SIGTERM", () => {
  server.close(() => console.log("actual shutdown completed"));
});
`,
      );
      server = await startPackagedNodeServer(root, process.env, {
        nodeExecutable: process.execPath,
        platform,
      });
      await server.close();
      assert.match(server.diagnostics(), /actual shutdown completed/);
      assert.equal(server.child.exitCode, 0);
    } finally {
      if (server?.child.exitCode === null) server.child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });
}
