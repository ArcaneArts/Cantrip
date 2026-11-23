// Enroll a production Node worker, stop it, and reopen its data with Rust.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { eventually, launchActualWorker } from "../server-rust/full-worker.mjs";
import { fixtureEnvironment, startServer } from "../server-rust/process.mjs";
import { projectLabel } from "../server-rust/security-fixtures.mjs";
import {
  initializeGrantProfile,
  verifyGrantFlow,
} from "./grant-server-flow.mjs";

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    worker: { type: "string" },
    codex: { type: "string" },
    cli: { type: "string" },
  },
});
assert.ok(
  values.server && values.worker,
  "Pass --server and --worker native executables.",
);

const root = await mkdtemp(path.join(tmpdir(), "cantrip-worker-upgrade-"));
const data = path.join(root, "worker profile");
const homeDirectory = path.join(root, "home");
const encryptionPath = path.join(data, "worker-encryption-key.json");
const readRecord = async (name) =>
  JSON.parse(await readFile(path.join(data, name), "utf8"));
let server, worker, accountMasterKey;
try {
  await mkdir(homeDirectory);
  const env = fixtureEnvironment(path.join(root, "server"));
  env.CANTRIP_BOOTSTRAP_MODE = "standalone";
  env.PATH = "";
  delete env.CANTRIP_WORKER_TOKEN;
  server = await startServer(
    path.resolve(values.server),
    ["--database", "pglite", "--port", "0", "--shutdown-on-stdin-close"],
    { cwd: root, env },
  );
  const call = async (method, route, body) => {
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
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const launch = ({ workerBinary, enrollmentCode }) =>
    launchActualWorker({ server }, data, {
      workerBinary,
      enrollmentCode,
      // Let the worker create and subsequently recover its own identity.
      workerId: "",
      homeDirectory,
      cliBinary: values.cli ? path.resolve(values.cli) : undefined,
      environment: {
        ...(workerBinary ? { PATH: "" } : {}),
        ...(values.codex
          ? { CANTRIP_CODEX_BIN: path.resolve(values.codex) }
          : {}),
      },
    });

  accountMasterKey = await initializeGrantProfile(call);
  const enrollment = await call("POST", "/api/workers/enrollment-codes", {
    label: "Existing worker profile fixture",
  });
  assert.equal(enrollment.status, 201);
  worker = launch({ workerBinary: null, enrollmentCode: enrollment.body.code });
  await worker.ready();
  const identity = await readRecord("worker-identity.json");
  const { workerId } = identity;
  assert.match(workerId, /^worker-[0-9a-f-]{36}$/u);
  const credential = await readRecord("worker-credential.json");
  assert.equal(credential.workerId, workerId);
  const versionRoute = "/api/workers/" + workerId + "/version";
  const readVersion = () =>
    eventually(
      () => call("GET", versionRoute),
      ({ status, body }) => {
        assert.equal(status, 200, JSON.stringify(body));
        assert.match(body.version, /^\d+\.\d+\.\d+$/u);
      },
      10_000,
    );
  await verifyGrantFlow(call, encryptionPath, workerId, {
    revoke: false,
    accountMasterKey,
  });
  await readVersion();
  const endpoint = await readRecord("worker-encryption-key.json");
  assert.equal(endpoint.acceptedRevisions["task-content"], 2);

  const chatId = randomUUID();
  const chatUrl = "/api/chats/" + chatId;
  const created = await call("POST", "/api/chats", {
    id: chatId,
    titleProtection: {
      ...projectLabel,
      classification: { recordKind: "chat" },
    },
    autoTitle: false,
  });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  assert.equal(created.body.activeWorkerId, workerId);
  const rootId = created.body.activeScratchRootId;
  assert.ok(rootId);
  await eventually(
    () =>
      server.events.find(
        (event) =>
          event.event === "standalone-chat.scratch.transitioned" &&
          event.chatId === chatId &&
          event.operation === "provision" &&
          event.status === "succeeded",
      ),
    assert.ok,
  );
  const scratch = await realpath(path.join(data, "chat-scratch", chatId));
  const scratchRecord = async () =>
    (await readRecord("chat-scratch-registry.json")).roots.find(
      (record) => record.rootId === rootId,
    );
  const routingRecord = async () =>
    (await readRecord("repository-routing.json")).records.find(
      ({ field, value }) => field === "path" && value === scratch,
    );
  const route = await routingRecord();
  assert.match(route?.token ?? "", /^ctrr_/);
  const markerDirectory = path.join(scratch, "nested files");
  const marker = path.join(markerDirectory, "notes.txt");
  const content = "Retained in the Node profile 🌱\n";
  await mkdir(markerDirectory);
  await writeFile(marker, content);
  assert.equal((await call("DELETE", chatUrl)).status, 204);
  const archived = await eventually(scratchRecord, (record) =>
    assert.ok(
      Date.parse(record?.archiveExpiresAt) > Date.parse(record?.archivedAt),
    ),
  );
  assert.equal(archived.chatId, chatId);
  await worker.close();

  worker = launch({ workerBinary: values.worker });
  await worker.ready();
  await readVersion();
  const reopened = await call(
    "POST",
    "/api/workers/" + workerId + "/encryption/refresh",
    {
      component: "task-content",
      keyRevision: 2,
    },
  );
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.status.state, "ready");
  assert.deepEqual(reopened.body.status.grants, [
    { component: "task-content", keyRevision: 2 },
  ]);
  assert.deepEqual(await scratchRecord(), archived);
  assert.equal((await call("POST", chatUrl + "/restore", {})).status, 200);
  await eventually(scratchRecord, (record) => {
    assert.deepEqual(record, {
      rootId,
      chatId,
      archivedAt: null,
      archiveExpiresAt: null,
    });
  });
  assert.equal(await readFile(marker, "utf8"), content);
  assert.deepEqual(await routingRecord(), route);
  await worker.close();
  worker = undefined;

  assert.deepEqual(await readRecord("worker-identity.json"), identity);
  const retainedCredential = await readRecord("worker-credential.json");
  assert.equal(retainedCredential.workerId, workerId);
  assert.equal(retainedCredential.serverUrl, credential.serverUrl);
  assert.ok(
    retainedCredential.credential === credential.credential,
    "Worker credential changed.",
  );
  const retainedEndpoint = await readRecord("worker-encryption-key.json");
  assert.equal(retainedEndpoint.principalId, endpoint.principalId);
  assert.deepEqual(retainedEndpoint.publicKey, endpoint.publicKey);
  assert.ok(
    retainedEndpoint.privateKey === endpoint.privateKey,
    "Endpoint private key changed.",
  );
  assert.deepEqual(
    retainedEndpoint.acceptedRevisions,
    endpoint.acceptedRevisions,
  );
  console.log(
    JSON.stringify({
      suite: "worker-profile-node-to-rust",
      workerIdentityRetained: true,
      enrollmentRetained: true,
      scopedGrantReopened: true,
      acceptedRevisionRetained: true,
      archivedScratchRestored: true,
      routingHandleRetained: true,
      scratchContentRetained: true,
      rustPathEmpty: true,
      bothWorkersStopped: true,
    }),
  );
} catch (error) {
  if (worker) console.error(worker.diagnostics().slice(-6000));
  throw error;
} finally {
  accountMasterKey?.fill(0);
  try {
    await worker?.close();
  } finally {
    try {
      await server?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
