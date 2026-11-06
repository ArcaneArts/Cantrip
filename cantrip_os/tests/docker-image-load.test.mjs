import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  LocalDocker,
  DockerApiError,
  DockerDeliveryError,
} from "../host/index.mjs";

async function server(handler, run) {
  const directory = await mkdtemp(join(tmpdir(), "cantrip-load-http-")),
    socket = join(directory, "engine.sock");
  const app = createServer(handler);
  await new Promise((resolve, reject) => {
    app.once("error", reject);
    app.listen(socket, resolve);
  });
  await chmod(socket, 0o600);
  try {
    await run(new LocalDocker(socket));
  } finally {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test("image loading streams raw input beyond JSON receipt limits with backpressure", async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 317, 0xa7),
    digest = createHash("sha256").update(bytes).digest("hex");
  let calls = 0;
  await server(
    (request, response) => {
      calls++;
      assert.equal(request.url, "/v1.41/images/load?quiet=true");
      assert.equal(request.headers["content-type"], "application/x-tar");
      const hash = createHash("sha256");
      let count = 0;
      request.on("data", (chunk) => {
        count += chunk.length;
        hash.update(chunk);
      });
      request.on("end", () => {
        assert.equal(count, bytes.length);
        assert.equal(hash.digest("hex"), digest);
        response.end('{"stream":"Loaded image"}\n');
      });
    },
    async (engine) => {
      assert.deepEqual(await engine.loadImage(Readable.from([bytes])), [
        { stream: "Loaded image" },
      ]);
    },
  );
  assert.equal(calls, 1);
});

for (const status of [403, 302])
  test(`actual HTTP ${status} load refusal is preserved without replay`, async () => {
    let calls = 0;
    await server(
      (request, response) => {
        calls++;
        response.writeHead(status);
        response.end('{"message":"actual refusal"}');
        request.resume();
      },
      async (engine) => {
        await assert.rejects(
          engine.loadImage(Readable.from([Buffer.alloc(5 * 1024 * 1024)])),
          (error) =>
            error instanceof DockerApiError &&
            error.status === status &&
            /actual refusal/.test(error.message),
        );
      },
    );
    assert.equal(calls, 1);
  });

test("embedded load errors, oversized and truncated replies retain unknown outcomes", async () => {
  for (const kind of ["embedded", "oversized", "truncated", "invalid"]) {
    let calls = 0;
    await server(
      (request, response) => {
        calls++;
        request.resume();
        request.once("end", () => {
          if (kind === "embedded")
            response.end('{"error":"actual invalid tar"}\n');
          else if (kind === "oversized")
            response.end("x".repeat(4 * 1024 * 1024 + 1));
          else if (kind === "invalid") response.end("invalid response");
          else {
            response.writeHead(200, { "Content-Length": "100" });
            response.write("partial");
            setImmediate(() => response.destroy());
          }
        });
      },
      async (engine) => {
        await assert.rejects(
          engine.loadImage(Readable.from([Buffer.from("tar")])),
          (e) => e instanceof DockerDeliveryError && e.delivery === "unknown",
        );
      },
    );
    assert.equal(calls, 1);
  }
});

test("input failure and actual socket timeout terminate one upload without retry", async () => {
  for (const kind of ["input", "timeout"]) {
    await server(
      (request) => request.resume(),
      async (engine) => {
        async function* archive() {
          yield Buffer.alloc(64 * 1024);
          if (kind === "input") throw new Error("actual source failure");
        }
        await assert.rejects(
          engine.loadImage(Readable.from(archive()), { timeout: 20 }),
          (e) => e instanceof DockerDeliveryError && e.delivery === "unknown",
        );
      },
    );
  }
});
