// Real production HTTP and unchanged worker WebSocket transport. Command effects
// are controlled; no worker filesystem/native-runtime product claim is made.
import assert from "node:assert/strict";
import path from "node:path";
import { cantripVersion } from "../../packages/version/dist/index.js";
import { managementWorker } from "./worker-management-http-worker.mjs";
import { localOwner } from "./project-target-state.mjs";
import { workerInferenceStatusSchema } from "../../packages/protocol/dist/index.js";

export async function workerBridgeRuntimeCases(
  origin,
  cookie,
  directory,
  waitForConsole,
  parent,
) {
  const evidence = (parent.workerBridge = {
    http: [],
    probes: [],
    commands: [],
    background: [],
    disconnects: 0,
  });
  let worker;
  const session = await fetch(origin + "/api/auth/session", {
    headers: { cookie, origin: "http://127.0.0.1:5173" },
  });
  assert.equal(session.status, 200);
  const sessionBody = await session.json();
  const csrf = sessionBody.csrfToken;
  const owner = sessionBody.currentUser?.id ?? localOwner;
  async function visit(name, method, route, options = {}) {
    const response = await fetch(origin + route, {
      method,
      headers: {
        origin: "http://127.0.0.1:5173",
        ...(options.client === "worker" ? {} : { cookie }),
        ...(csrf && options.client !== "worker"
          ? { "x-cantrip-csrf": csrf }
          : {}),
        ...(options.json === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(options.json === undefined
        ? {}
        : { body: JSON.stringify(options.json) }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    const requestId = response.headers.get("x-request-id");
    if (body?.requestId !== undefined) {
      assert.match(body.requestId, /^[0-9a-f-]{36}$/);
      assert.equal(
        body.requestId,
        requestId,
        "error body correlates to its actual HTTP request",
      );
    }
    evidence.http.push({
      name,
      method,
      route,
      status: response.status,
      body,
      requestId,
    });
    if (options.status !== null)
      assert.equal(
        response.status,
        options.status ?? 200,
        JSON.stringify(body),
      );
    return body;
  }
  async function probe(name, method, route, options) {
    const body = await visit(name, method, route, options);
    const response = evidence.http.at(-1);
    evidence.probes.push({ name, status: response.status, body });
    return body;
  }
  try {
    const bootstrap = await visit("bridge bootstrap", "GET", "/api/bootstrap");
    worker = await managementWorker({
      f: { server: { origin } },
      visit,
      root: path.join(directory, "controlled-worker"),
      state: evidence,
      handlers: {
        "inference.configure": async (command) =>
          workerInferenceStatusSchema.parse({
            serverId: bootstrap.server.id,
            ownerId: owner,
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
          }),
        "worker.version": async () => {
          evidence.commands.push({ type: "worker.version" });
          return cantripVersion;
        },
        "model.ollama.catalog": async () => ({
          models: [],
          observedAt: new Date().toISOString(),
        }),
      },
    });
    await probe(
      "version before reconnect",
      "GET",
      "/api/workers/alpha/version",
    );
    await probe("restart acknowledged", "POST", "/api/workers/alpha/restart", {
      json: {},
      status: 202,
    });
    evidence.failRestart = true;
    const failure = await probe(
      "worker-reported failure",
      "POST",
      "/api/workers/alpha/restart",
      { json: {}, status: null },
    );
    assert.ok(evidence.probes.at(-1).status >= 400, JSON.stringify(failure));
    evidence.failRestart = false;
    const text = (parent.stdout + parent.stderr).replace(/\x1b\[[0-9;]*m/g, "");
    const previous = text.split("Worker connection interrupted").length - 1;
    worker.close();
    await waitForConsole("Worker connection interrupted", previous);
    await worker.start();
    await probe("version after reconnect", "GET", "/api/workers/alpha/version");
    assert.equal(
      evidence.probes.filter((p) => p.name.startsWith("version")).length,
      2,
    );
    return {
      close: () => worker.close(),
      async prepareShutdown() {
        // Compare a causally ordered lifecycle here. Connected-server shutdown
        // is tested separately over real wire with held/early/missing ACKs:
        // socket close and app onClose may win in either order in production.
        evidence.shutdownScenario =
          "client-close-observed-before-server-signal";
        const text = (parent.stdout + parent.stderr).replace(
          /\x1b\[[0-9;]*m/g,
          "",
        );
        const previous = text.split("Worker connection interrupted").length - 1;
        worker.close();
        await waitForConsole("Worker connection interrupted", previous);
      },
    };
  } catch (error) {
    worker?.close();
    throw error;
  }
}

export function verifyWorkerBridgeRuntime(records, evidence) {
  const operations = new Set(["worker.version", "worker.restart"]);
  const lifecycle = [],
    commands = {},
    aliases = new Map(),
    counts = new Map();
  for (const record of records) {
    const event = record.context?.event;
    if (!event?.startsWith("worker.")) continue;
    const command =
      event.startsWith("worker.command.") &&
      event !== "worker.command.abandoned";
    if (command && !operations.has(record.context.operation)) continue;
    if (
      !command &&
      !["worker.connection.", "worker.bridge.", "worker.transport."].some(
        (prefix) => event.startsWith(prefix),
      ) &&
      event !== "worker.command.abandoned"
    )
      continue;
    const row = structuredClone(record);
    assert.equal(new Date(row.timestamp).toISOString(), row.timestamp);
    delete row.timestamp;
    delete row.cursor;
    if (row.context.durationMs !== undefined) {
      assert.ok(
        Number.isFinite(row.context.durationMs) && row.context.durationMs >= 0,
      );
      delete row.context.durationMs;
    }
    if (command) {
      const id = row.context.requestId;
      assert.match(id, /^[0-9a-f-]{36}$/);
      if (event === "worker.command.dispatched") {
        assert.ok(!aliases.has(id));
        const op = row.context.operation,
          n = (counts.get(op) ?? 0) + 1;
        counts.set(op, n);
        aliases.set(id, `${op}:${n}`);
      }
      const alias = aliases.get(id);
      assert.ok(alias, "completion follows its real dispatch");
      row.context.requestId = alias;
      (commands[alias] ??= []).push(row);
    } else lifecycle.push(row);
  }
  assert.equal(counts.get("worker.version"), 2);
  assert.equal(counts.get("worker.restart"), 2);
  for (const rows of Object.values(commands)) {
    assert.equal(rows.length, 2);
    assert.equal(rows[0].context.event, "worker.command.dispatched");
    assert.ok(
      ["worker.command.completed", "worker.command.failed"].includes(
        rows[1].context.event,
      ),
    );
  }
  assert.equal(
    lifecycle.filter(
      (r) => r.context.event === "worker.bridge.shutdown-started",
    ).length,
    1,
  );
  assert.equal(
    lifecycle.filter(
      (r) => r.context.event === "worker.bridge.shutdown-completed",
    ).length,
    1,
  );
  assert.ok(
    !JSON.stringify(records).includes("Controlled worker restart failure"),
    "worker error text stays out of the server archive",
  );
  const probes = structuredClone(evidence.probes);
  for (const probe of probes) {
    if (probe.body?.requestId !== undefined) {
      assert.match(probe.body.requestId, /^[0-9a-f-]{36}$/);
      probe.body.requestId = "<request>";
    }
  }
  return { probes, lifecycle, commands };
}
