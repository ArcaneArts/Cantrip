// Core's public WorkerLink authority over the production native command socket.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  workerLinkResourceGrantSchema,
  workerLinkSessionSchema,
} from "../../packages/protocol/dist/worker-link.js";
import {
  generateAccountMasterKey,
  generateHpkeKeyPair,
  publicKeyForPair,
  wrapAccountMasterKeyForClient,
} from "../../packages/crypto/dist/index.js";
import { fixtureEnvironment, startServer } from "../server-rust/process.mjs";

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    worker: { type: "string" },
    tunnel: { type: "boolean" },
  },
});
assert.ok(values.server && values.worker, "Pass --server and --worker.");

const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-workerlink-authority-"),
);
const workerId = "native-workerlink-authority";
const environment = fixtureEnvironment(path.join(root, "server"));
environment.CANTRIP_BOOTSTRAP_MODE = "standalone";
environment.CANTRIP_WORKER_LINK_LOCAL_ENABLED = "true";
delete environment.CANTRIP_WORKER_TOKEN;
let server;
let child;
let completion;
let diagnostics = "";
const master = generateAccountMasterKey();

async function call(method, route, expected, body) {
  const response = await fetch(server.origin + route, {
    method,
    headers: {
      origin: "http://127.0.0.1:5173",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  assert.equal(response.status, expected, method + " " + route + " " + text);
  return text ? JSON.parse(text) : null;
}

function assertRenewed(before, after) {
  assert.equal(after.issuedAt, before.issuedAt);
  assert.equal(after.absoluteExpiresAt, before.absoluteExpiresAt);
  assert.ok(Date.parse(after.expiresAt) > Date.parse(before.expiresAt));
  assert.ok(Date.parse(after.expiresAt) <= Date.parse(after.absoluteExpiresAt));
}

try {
  server = await startServer(
    path.resolve(values.server),
    ["--database", "pglite", "--port", "0", "--shutdown-on-stdin-close"],
    { cwd: root, env: environment },
  );
  const ownerId = "00000000-0000-0000-0000-000000000001";
  {
    const id = randomUUID();
    const publicKey = await publicKeyForPair(await generateHpkeKeyPair());
    await call("POST", "/api/encryption/profile/initialize", 201, {
      profile: {
        formatVersion: 1,
        activeMasterKeyRevision: 1,
        passwordKdf: null,
        passwordWrappedMasterKey: null,
        payloadMigrationStatus: "pending",
      },
      initialClient: {
        id,
        label: "WorkerLink authority fixture",
        publicKey,
        wrappedMasterKey: await wrapAccountMasterKeyForClient({
          ownerId,
          clientId: id,
          accountMasterKey: master,
          masterKeyRevision: 1,
          clientPublicKey: publicKey,
        }),
      },
    });
  }
  const enrollment = await call("POST", "/api/workers/enrollment-codes", 201, {
    label: "WorkerLink authority fixture",
  });
  child = spawn(path.resolve(values.worker), ["--shutdown-on-stdin-close"], {
    cwd: root,
    env: {
      ...environment,
      PATH: "",
      NO_COLOR: "1",
      CANTRIP_LOG_LEVEL: "debug",
      CANTRIP_SERVER_URL: server.origin,
      CANTRIP_WORKER_DATA_DIR: path.join(root, "worker"),
      CANTRIP_WORKER_ID: workerId,
      CANTRIP_WORKER_ENROLLMENT_CODE: enrollment.code,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-24_000);
    });
  }
  const ready = /event=worker\.connection\.connected/;
  const deadline = Date.now() + 20_000;
  while (
    !ready.test(diagnostics) &&
    child.exitCode === null &&
    Date.now() < deadline
  )
    await delay(50);
  assert.match(diagnostics, ready);
  const clientInstanceId = randomUUID();
  const open = async () =>
    workerLinkSessionSchema.parse(
      await call(
        "POST",
        "/api/workers/" + workerId + "/worker-link/sessions",
        201,
        {
          clientInstanceId,
        },
      ),
    );
  const session = await open();
  assert.equal(session.identity.workerId, workerId);
  assert.equal(session.identity.ownerId, ownerId);
  assert.equal(session.identity.clientInstanceId, clientInstanceId);
  assert.equal(session.preferredRoute, "local");
  const base = "/api/worker-links/" + session.sessionId;
  const grant = workerLinkResourceGrantSchema.parse(
    await call("POST", base + "/observations/grant", 201, {
      topics: ["filesystem", "runtime"],
    }),
  );
  assert.deepEqual(grant.binding.identity, session.identity);
  assert.equal(grant.binding.sessionId, session.sessionId);
  assert.equal(grant.binding.resource.resourceId, workerId);
  assert.deepEqual(grant.binding.operations, ["events:subscribe"]);
  const grantRoute = base + "/grants/" + grant.binding.grantId;
  const renewed = workerLinkSessionSchema.parse(
    await call("POST", base + "/renew", 200),
  );
  assertRenewed(session.lease, renewed.lease);
  assertRenewed(
    grant.binding.lease,
    await call("POST", grantRoute + "/renew", 200),
  );
  const replaced = workerLinkSessionSchema.parse(
    await call("POST", base + "/route", 200, { preferredRoute: "relay" }),
  );
  assert.equal(replaced.routeGeneration, session.routeGeneration + 1);
  assert.equal(replaced.preferredRoute, "relay");
  await call("DELETE", grantRoute, 204);
  await call("POST", grantRoute + "/renew", 409);
  await call("DELETE", base, 204);
  await call("POST", base + "/renew", 404);
  const next = await open();
  assert.notEqual(next.sessionId, session.sessionId);
  assert.deepEqual(next.identity, session.identity);

  for (const command of [
    "identity.resolve",
    "session.install",
    "session.renew",
    "session.route",
    "session.revoke",
    "grant.install",
    "grant.renew",
    "grant.revoke",
  ]) {
    assert.ok(
      diagnostics.includes(
        "event=worker.command.completed operation=worker-link." + command,
      ),
      "Native worker completed " + command,
    );
  }
  if (values.tunnel) {
    const { verifyWorkerLinkTunnel } =
      await import("./worker-link-tunnel-cases.mjs");
    const relay = await call(
      "POST",
      "/api/worker-links/" + next.sessionId + "/route",
      200,
      { preferredRoute: "relay" },
    );
    await verifyWorkerLinkTunnel({
      origin: server.origin,
      call,
      relay,
      ownerId,
      workerId,
      workerDirectory: path.join(root, "worker"),
      master,
    });
    assert.match(diagnostics, /event=tunnel\.destination\.connected/);
    assert.match(diagnostics, /event=tunnel\.protected-target\.rejected/);
  }
  console.log(
    JSON.stringify({ suite: "native-workerlink-authority", passed: true }),
  );
} catch (error) {
  console.error(diagnostics, server?.diagnostics());
  throw error;
} finally {
  master.fill(0);
  try {
    if (child) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        assert.equal(await completion, 0, diagnostics);
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    try {
      await server?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
