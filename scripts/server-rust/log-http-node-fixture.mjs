// Real production Fastify/logger factory, with development-only controlled bodies.
import { parseArgs } from "node:util";
import { access } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { readServerConfig } from "../../tests/reference-node-server/src/config.ts";
import {
  initializeServerLogArchive,
  closeServerLogArchive,
} from "../../tests/reference-node-server/src/logger.ts";
import { createApplicationServer } from "../../tests/reference-node-server/src/app/http/server.ts";
const { values } = parseArgs({ options: { "data-dir": { type: "string" } } });
const root = values["data-dir"];
await initializeServerLogArchive(root);
const { app } = createApplicationServer(readServerConfig(), true);
app.get("/api/log-test/finite/:id", async () => "complete");
app.get("/api/log-test/empty", async (_request, reply) =>
  reply.code(204).send(),
);
app.get("/api/log-test/status/:code", async (request, reply) =>
  reply.code(Number(request.params.code)).send("status"),
);
const levels = ["trace", "debug", "info", "warn", "error", "fatal", "silent"];
for (const level of levels)
  app.get(
    `/api/log-test/level/${level}/status/:code`,
    { logLevel: level },
    async (request, reply) =>
      reply.code(Number(request.params.code)).send("status"),
  );
for (const level of [null, ...levels])
  for (const kind of ["slow", "failed"])
    app.get(
      `/api/log-test/${level ? `level/${level}/` : ""}${kind}/:id`,
      { ...(level ? { logLevel: level } : {}) },
      async (request, reply) => {
        const marker = path.join(root, request.params.id);
        return reply.type("application/octet-stream").send(
          Readable.from(
            (async function* () {
              yield Buffer.from("first\n");
              while (
                !(await access(marker).then(
                  () => true,
                  () => false,
                ))
              )
                await delay(5);
              if (kind === "failed")
                throw new Error("controlled-private-stream-body");
              yield Buffer.from("last\n");
            })(),
          ),
        );
      },
    );
const origin = await app.listen({ host: "127.0.0.1", port: 0 });
console.log(JSON.stringify({ event: "server.listening", origin }));
process.stdin.resume();
await new Promise((resolve) => process.stdin.once("end", resolve));
await app.close();
await closeServerLogArchive();
