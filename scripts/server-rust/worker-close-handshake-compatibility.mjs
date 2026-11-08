// Actual production processes and worker HTTP/WebSocket protocols. Delay only
// the test client's public ws.close() ACK; server lifecycle code is unchanged.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { fixtureEnvironment } from "./process.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { heartbeat } from "./security-fixtures.mjs";
import { repositoryRoot } from "./build.mjs";
import { cantripVersion } from "../../packages/version/dist/index.js";
import {
  cantripVersionSchema,
  workerInferenceStatusSchema,
} from "../../packages/protocol/dist/index.js";
import { localOwner } from "./project-target-state.mjs";
import {
  workerAuthenticationCloseCase,
  rejectedWorkerAuthenticationCloseCase,
} from "./worker-authentication-close-cases.mjs";
const WebSocket = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("ws");
const { values } = parseArgs({
  options: {
    report: { type: "string" },
    peer: { type: "string", default: "both" },
    database: { type: "string", default: "postgres" },
    "withhold-ack": { type: "boolean", default: false },
    "ack-before-response": { type: "boolean", default: false },
    "hold-authentication": { type: "boolean", default: false },
    "reject-authentication": { type: "boolean", default: false },
  },
});
const report = { peers: [], completeReplacement: false };
const root = (report.root = await mkdtemp(
  path.join(tmpdir(), "cantrip-worker-close-"),
));
console.error(JSON.stringify({ event: "worker-close.created", root }));
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function within(promise, label, ms = 15000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, no) => {
        timer = setTimeout(() => no(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
let pg, failure;
try {
  pg = await postgresFixture(path.join(root, "postgres"));
  for (const kind of values.peer === "both"
    ? ["node", "rust"]
    : [values.peer]) {
    const item = {
      kind,
      database: values.database,
      stdout: "",
      stderr: "",
      stages: [],
    };
    report.peers.push(item);
    const directory = path.join(root, kind);
    await mkdir(directory);
    const listener = createServer();
    await new Promise((yes) => listener.listen(0, "127.0.0.1", yes));
    const port = listener.address().port;
    await new Promise((yes) => listener.close(yes));
    const origin = `http://127.0.0.1:${port}`;
    const env = {
      ...fixtureEnvironment(directory),
      CANTRIP_SERVER_PORT: String(port),
      CANTRIP_LOG_LEVEL: "debug",
      CANTRIP_LICENSE_WHITELIST_ENABLED: "false",
    };
    if (
      values.database !== "pglite" &&
      (kind === "node" || values.database === "postgres")
    )
      env.DATABASE_URL = await pg.database();
    const args = ["--port", String(port), "--database", values.database];
    if (values.database === "bundled-postgres")
      args.push(
        "--postgres-bin-dir",
        process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
      );
    const child = spawn(
      kind === "node"
        ? process.execPath
        : process.env.CANTRIP_RUST_SERVER_BINARY,
      kind === "node"
        ? ["--import", "tsx", "cantrip_server/src/index.ts"]
        : args,
      { cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (bytes) => {
      item.stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
      item.stderr += bytes;
    });
    const completion = new Promise((yes, no) => {
      child.once("error", no);
      child.once("close", (code, signal) => yes({ code, signal }));
    });
    let socket;
    try {
      const deadline = Date.now() + 60000;
      for (;;) {
        assert.equal(child.exitCode, null, item.stdout + item.stderr);
        try {
          if (
            (
              await fetch(origin + "/readyz", {
                signal: AbortSignal.timeout(1000),
              })
            ).status === 200
          )
            break;
        } catch {}
        assert.ok(Date.now() < deadline, "actual production readiness");
        await delay(25);
      }
      async function request(route, body) {
        const r = await fetch(origin + route, {
          method: body ? "POST" : "GET",
          headers: {
            origin: "http://127.0.0.1:5173",
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(30000),
        });
        return { status: r.status, body: await r.json() };
      }
      const code = await request("/api/workers/enrollment-codes", {
        label: "close handshake",
      });
      assert.equal(code.status, 201);
      const enrolled = await request("/api/internal/workers/enroll", {
        code: code.body.code,
        heartbeat: { ...heartbeat, workerId: "alpha", name: "close handshake" },
      });
      assert.equal(enrolled.status, 201);
      if (values["reject-authentication"]) {
        await rejectedWorkerAuthenticationCloseCase({
          item,
          child,
          origin,
          completion,
        });
        continue;
      }
      if (values["hold-authentication"]) {
        assert.equal(
          values.database,
          "postgres",
          "row-lock scenario uses its isolated external PostgreSQL",
        );
        await workerAuthenticationCloseCase({
          item,
          child,
          origin,
          credential: enrolled.body.credential,
          url: env.DATABASE_URL,
          completion,
        });
        continue;
      }
      const bootstrap = await request("/api/bootstrap");
      assert.equal(bootstrap.status, 200);
      const ready = deferred(),
        held = deferred(),
        closeReceived = deferred(),
        ended = deferred();
      socket = new WebSocket(
        `${origin.replace(/^http/, "ws")}/api/internal/workers/connect?workerId=alpha&connectionGeneration=${randomUUID()}`,
        ["cantrip-worker-auth-ready-v2"],
        { headers: { authorization: `Bearer ${enrolled.body.credential}` } },
      );
      socket.on("error", (error) => {
        item.socketError = error.message;
      });
      socket.once("close", (code, reason) =>
        ended.resolve({ code, reason: reason.toString() }),
      );
      const realClose = socket.close.bind(socket);
      // ws's receiver calls this public method on CLOSE. Hold its ACK while
      // preserving incoming frame parsing, actual TCP IO and server behavior.
      socket.close = (code, reason) => {
        item.closeReceivedAt = Date.now();
        item.closeFrame = {
          code: code ?? 1005,
          reason: reason?.toString() ?? "",
        };
        item.stages.push("close-frame-received-ack-held");
        closeReceived.resolve();
      };
      socket.on("message", (bytes) => {
        const envelope = JSON.parse(bytes.toString());
        if (envelope.kind === "connection" && envelope.state === "ready")
          ready.resolve();
        if (envelope.kind !== "request") return;
        if (envelope.command.type === "worker.version") {
          item.requestId = envelope.requestId;
          held.resolve(envelope);
          return;
        }
        const command = envelope.command;
        let result;
        if (command.type === "inference.configure")
          result = workerInferenceStatusSchema.parse({
            serverId: bootstrap.body.server.id,
            ownerId: localOwner,
            workerId: "alpha",
            workerGeneration: "controlled-generation",
            revision: 0,
            providerCatalogRevision: command.catalogRevision ?? 0,
            pools: command.configurations.map((configuration) => ({
              ...configuration,
              activeCount: 0,
              queuedCount: 0,
              operations: [],
            })),
          });
        else if (command.type === "model.ollama.catalog")
          result = { models: [], observedAt: new Date().toISOString() };
        else if (command.type === "worktree.observation.configure")
          result = { accepted: true, paths: [] };
        socket.send(
          JSON.stringify({
            kind: "response",
            requestId: envelope.requestId,
            ...(result === undefined
              ? {
                  ok: false,
                  error: {
                    code: "controlled-background",
                    message: "Controlled background endpoint",
                  },
                }
              : { ok: true, result }),
          }),
        );
      });
      await within(ready.promise, "worker authenticated readiness");
      const configuredBy = Date.now() + 15000;
      while (
        !(item.stdout + item.stderr)
          .split("\n")
          .some(
            (line) =>
              line.includes("Worker command completed") &&
              line.includes("operation=inference.configure"),
          )
      ) {
        assert.ok(
          Date.now() < configuredBy,
          "actual initial inference configuration completion",
        );
        await delay(10);
      }
      let httpSettled = false;
      const http = request("/api/workers/alpha/version").then((result) => {
        httpSettled = true;
        item.response = result;
        return result;
      });
      // Keep rejected promises observed even if a preceding assertion fails.
      http.catch(() => {});
      const pending = await within(
        held.promise,
        "actual admitted version command",
      );
      item.stages.push("http-command-admitted");
      child.kill("SIGTERM");
      item.stages.push("sigterm-sent");
      await within(closeReceived.promise, "actual server close frame");
      await delay(150);
      item.held = {
        processAlive: child.exitCode === null,
        httpSettled,
        tcpEnded: socket._socket.readableEnded,
        interrupted: (item.stdout + item.stderr).includes(
          "Worker connection interrupted",
        ),
      };
      assert.deepEqual(
        item.closeFrame,
        { code: 1005, reason: "" },
        "planned shutdown sends empty CLOSE",
      );
      assert.deepEqual(
        item.held,
        {
          processAlive: true,
          httpSettled: false,
          tcpEnded: false,
          interrupted: false,
        },
        "no disconnect or transport termination before peer ACK while HTTP remains active",
      );
      if (values["ack-before-response"]) {
        realClose();
        item.stages.push("close-ack-released-with-http-pending");
        item.socketClosed = await within(
          ended.promise,
          "actual peer close acknowledgment",
        );
        const interruptedBy = Date.now() + 5000;
        while (
          !(item.stdout + item.stderr).includes("Worker connection interrupted")
        ) {
          assert.ok(Date.now() < interruptedBy, "actual post-ACK interruption");
          await delay(10);
        }
        assert.equal(
          httpSettled,
          false,
          "physical interruption retains pending command grace",
        );
        assert.ok(
          !(item.stdout + item.stderr).includes("Worker bridge stopped"),
          "HTTP drain precedes logical bridge shutdown",
        );
        const response = await within(
          http,
          "disconnected command settles after actual reconnect grace",
          30000,
        );
        assert.deepEqual(response, {
          status: 503,
          body: { error: "Worker alpha disconnected." },
        });
        item.exit = await within(
          completion,
          "graceful shutdown after grace expiry",
        );
        assert.deepEqual(item.exit, { code: 0, signal: null });
        assert.deepEqual(item.socketClosed, item.closeFrame);
        continue;
      }
      socket.send(
        JSON.stringify({
          kind: "response",
          requestId: pending.requestId,
          ok: true,
          result: cantripVersion,
        }),
      );
      item.stages.push("response-sent-after-close-before-ack");
      assert.deepEqual(
        await within(http, "in-flight HTTP finishes from late worker response"),
        { status: 200, body: cantripVersionSchema.parse(cantripVersion) },
      );
      await delay(150);
      item.afterHttp = {
        processAlive: child.exitCode === null,
        tcpEnded: socket._socket.readableEnded,
        interrupted: (item.stdout + item.stderr).includes(
          "Worker connection interrupted",
        ),
      };
      assert.deepEqual(
        item.afterHttp,
        { processAlive: true, tcpEnded: false, interrupted: false },
        "completed HTTP preserves the physical closing handshake",
      );
      // Release after actual HTTP completion; the runtime must retain the
      // physical transport until its peer acknowledges CLOSE.
      if (!values["withhold-ack"]) {
        realClose(
          item.closeFrame.code === 1005 ? undefined : item.closeFrame.code,
          item.closeFrame.reason,
        );
        item.stages.push("close-ack-released");
      } else item.stages.push("close-ack-withheld-until-server-timeout");
      item.socketClosed = await within(
        ended.promise,
        "worker TCP/close completion",
        values["withhold-ack"] ? 40000 : 15000,
      );
      item.closeDurationMs = Date.now() - item.closeReceivedAt;
      if (values["withhold-ack"])
        assert.ok(
          item.closeDurationMs >= 28000 && item.closeDurationMs < 40000,
          "actual reference thirty-second closing deadline",
        );
      assert.deepEqual(item.socketClosed, item.closeFrame);
      item.exit = await within(completion, "production graceful shutdown");
      assert.deepEqual(item.exit, { code: 0, signal: null });
    } finally {
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      item.exit ??= await completion;
    }
  }
} catch (error) {
  failure = error;
  report.failure = error.stack;
} finally {
  await pg?.close();
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    peers: report.peers.map(
      ({ kind, database, closeFrame, held, response, exit }) => ({
        kind,
        database,
        closeFrame,
        held,
        response,
        exit,
      }),
    ),
    root,
  }),
);
