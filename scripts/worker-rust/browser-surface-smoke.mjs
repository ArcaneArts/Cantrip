// Real Core and native worker with a disposable encrypted browser surface.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  decryptRemoteSurfaceStreamPayload,
  decryptSurfacePrivateState,
  deriveComponentKey,
  encryptRemoteSurfaceStreamPayload,
  encryptSurfacePrivateState,
  generateAccountMasterKey,
  generateHpkeKeyPair,
  publicKeyForPair,
  wrapAccountMasterKeyForClient,
  wrapComponentKeyForWorker,
} from "../../packages/crypto/dist/index.js";
import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  remoteSurfaceConfigurationSchema,
} from "../../packages/protocol/dist/remote-surfaces.js";
import { eventually } from "../server-rust/full-worker.mjs";
import { fixtureEnvironment, startServer } from "../server-rust/process.mjs";
import {
  json,
  label,
  literal,
  localOwner,
} from "../server-rust/project-target-state.mjs";
import { repositoryFixture } from "../server-rust/repository-fixture.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["server", "worker", "repository", "chromium"].map((name) => [
      name,
      { type: "string" },
    ]),
  ),
});
assert.ok(
  values.server && values.worker && values.repository && values.chromium,
);
const WebSocket = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("ws");
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-native-browser-surface-"),
);
const workerDirectory = path.join(root, "worker");
const dataDirectory = path.join(root, "core");
const environment = {
  ...fixtureEnvironment(dataDirectory),
  CANTRIP_BOOTSTRAP_MODE: "standalone",
};
delete environment.CANTRIP_WORKER_TOKEN;
const ownerId = localOwner;
const workerId = "native-browser-surface-worker";
const projectId = "browser-surface-fixture-project";
const surfaceId = "native-browser-surface-fixture";
const component = "surface-private-state";
const keyRevision = 1;
const viewport = { width: 640, height: 480, devicePixelRatio: 1 };
const master = generateAccountMasterKey();
const componentKey = deriveComponentKey({
  accountMasterKey: master,
  ownerId,
  component,
  keyRevision,
});
const clients = [];
const visits = [];
let browserIdentity;
let logs = "";
let worker;
let core;

const target = createServer((request, response) => {
  visits.push(request.url);
  const title =
    request.url === "/second" ? "Native second page" : "Native first page";
  response.writeHead(200, { "content-type": "text/html" });
  response.end(
    "<!doctype html><title>" +
      title +
      '</title><input autofocus style="position:absolute;left:8px;top:8px" oninput="document.title=this.value">',
  );
});
target.listen(0, "127.0.0.1");
await once(target, "listening");
const origin = "http://127.0.0.1:" + target.address().port;

async function launchCore(port = 0) {
  core = await startServer(
    path.resolve(values.server),
    [
      "--database",
      "pglite",
      "--port",
      String(port),
      "--shutdown-on-stdin-close",
    ],
    { cwd: root, env: environment },
  );
}

async function call(method, route, status, body) {
  const result = await fetch(core.origin + route, {
    method,
    headers: {
      origin: "http://127.0.0.1:5173",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(35_000),
  });
  const text = await result.text();
  assert.equal(result.status, status, method + " " + route + " " + text);
  return text ? JSON.parse(text) : null;
}

async function launchWorker(enrollmentCode) {
  logs = "";
  const child = spawn(
    path.resolve(values.worker),
    ["--shutdown-on-stdin-close"],
    {
      cwd: root,
      env: {
        ...environment,
        PATH: "",
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "scratch"),
        NO_COLOR: "1",
        CANTRIP_LOG_LEVEL: "debug",
        CANTRIP_SERVER_URL: core.origin,
        CANTRIP_WORKER_DATA_DIR: workerDirectory,
        CANTRIP_WORKER_ID: workerId,
        CANTRIP_CHROMIUM_EXECUTABLE: path.resolve(values.chromium),
        ...(enrollmentCode
          ? { CANTRIP_WORKER_ENROLLMENT_CODE: enrollmentCode }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  worker = { child, exit: once(child, "exit") };
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      logs = (logs + chunk).slice(-48_000);
    });
  }
  await eventually(
    () =>
      child.exitCode === null && logs.includes("worker.connection.connected"),
    (ready) => assert.ok(ready, logs),
    12_000,
  );
}

async function stopWorker() {
  if (!worker) return;
  const { child, exit } = worker;
  worker = undefined;
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    assert.equal((await exit)[0], 0, logs);
  } finally {
    clearTimeout(timer);
  }
}

function privateContext(resource, operationId = null) {
  return {
    serverId: browserIdentity,
    resource,
    resourceId: surfaceId,
    operationId,
    recordKind: "browser-state",
  };
}

function location(resource, url, operationId = null) {
  return encryptSurfacePrivateState({
    ownerId,
    keyRevision,
    componentKey,
    context: privateContext(resource, operationId),
    content: {
      version: 1,
      classification: { recordKind: "browser-state" },
      revision: 1,
      url,
    },
  });
}

class BrowserSocket {
  inbox = [];
  counter = 0;

  constructor() {
    this.socket = new WebSocket(
      core.origin.replace(/^http/u, "ws") +
        "/api/remote-surfaces/" +
        surfaceId +
        "/connect?width=640&height=480",
      { origin: "http://127.0.0.1:5173" },
    );
    this.socket.on("message", (packet, binary) => {
      this.inbox.push(
        binary
          ? decodeRemoteSurfaceFrame(packet)
          : JSON.parse(packet.toString()),
      );
      if (this.inbox.length > 128) this.inbox.shift();
    });
    this.socket.on("error", (error) =>
      this.inbox.push({ type: "error", message: error.message }),
    );
    clients.push(this);
  }

  context(header, direction) {
    const { attachmentId, channel, sequence } = header;
    return {
      serverId: browserIdentity,
      surfaceKind: "browser",
      surfaceId,
      attachmentId,
      direction,
      channel,
      sequence,
    };
  }

  async next(select) {
    const limit = Date.now() + 12_000;
    while (Date.now() < limit) {
      const value = this.inbox.shift();
      if (!value) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      } else if (value.type === "error") {
        assert.fail(value.message);
      } else if (await select(value)) {
        return value;
      }
    }
    assert.fail("Browser surface message timed out");
  }

  async ready() {
    const value = await this.next((value) => value.type === "ready");
    assert.equal(value.transport, "websocket");
    assert.equal(value.surfaceId, surfaceId);
    this.attachment = value.attachmentId;
    await this.send({ type: "viewport", viewport });
  }

  async send(message, { invalid = false } = {}) {
    const header = {
      protocolVersion: 1,
      surfaceId,
      attachmentId: this.attachment,
      channel: "control",
      sequence: this.counter++,
    };
    const payload = await encryptRemoteSurfaceStreamPayload({
      ownerId,
      componentKey,
      keyRevision,
      context: this.context(header, "client-to-worker"),
      plaintext: Buffer.from(JSON.stringify(message)),
    });
    if (invalid) payload[payload.length - 1] ^= 1;
    this.socket.send(encodeRemoteSurfaceFrame(header, payload));
  }

  async clear(value) {
    assert.equal(value.header.surfaceId, surfaceId);
    assert.equal(value.header.attachmentId, this.attachment);
    return decryptRemoteSurfaceStreamPayload({
      ownerId,
      componentKey,
      keyRevision,
      protectedPayload: value.payload,
      context: this.context(value.header, "worker-to-client"),
    });
  }

  async title(expected) {
    let state;
    await this.next(async (value) => {
      if (value.header?.channel !== "control") return false;
      const message = JSON.parse(
        Buffer.from(await this.clear(value)).toString(),
      );
      if (
        message.type !== "browser-state" ||
        message.title !== expected ||
        message.loading
      )
        return false;
      assert.equal(message.url, undefined);
      state = await decryptSurfacePrivateState({
        ownerId,
        keyRevision,
        componentKey,
        context: privateContext("browser-operation", message.operationId),
        opaque: message.stateProtection,
      });
      return true;
    });
    return state.url;
  }
}

try {
  await mkdir(path.join(root, "home"));
  await mkdir(path.join(root, "scratch"));
  await launchCore();
  const port = Number(new URL(core.origin).port);
  const clientId = randomUUID();
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
      id: clientId,
      label: "Native browser fixture",
      publicKey,
      wrappedMasterKey: await wrapAccountMasterKeyForClient({
        ownerId,
        clientId,
        accountMasterKey: master,
        masterKeyRevision: 1,
        clientPublicKey: publicKey,
      }),
    },
  });
  const enrollment = await call("POST", "/api/workers/enrollment-codes", 201, {
    label: "Native browser fixture",
  });
  await launchWorker(enrollment.code);
  const identityPath = path.join(workerDirectory, "worker-encryption-key.json");
  const principal = await eventually(
    async () => {
      const key = JSON.parse(await readFile(identityPath, "utf8"));
      return (await call("GET", "/api/encryption/principals", 200)).find(
        ({ id }) => id === key.principalId,
      );
    },
    (value) => assert.ok(value),
    12_000,
  );
  await call(
    "POST",
    "/api/encryption/principals/" + principal.id + "/approve",
    200,
    { expectedRevision: principal.revision },
  );
  await call(
    "POST",
    "/api/encryption/principals/" + principal.id + "/grants",
    201,
    {
      component,
      keyRevision,
      wrappedKey: await wrapComponentKeyForWorker({
        ownerId,
        workerId,
        component,
        keyRevision,
        componentKey,
        workerPublicKey: principal.publicKey,
      }),
    },
  );
  browserIdentity = JSON.parse(await readFile(identityPath, "utf8")).serverId;
  assert.equal(typeof browserIdentity, "string");
  await stopWorker();
  await core.close();
  core = undefined;

  const repository = await repositoryFixture({
    kind: "rust",
    executable: path.resolve(values.repository),
    databaseMode: "pglite",
    root,
    dataDirectory,
  });
  try {
    const project = literal(projectId);
    const id = literal(surfaceId);
    const worker = literal(workerId);
    const title = json(label("browser"));
    const initial = json(await location("browser-row", origin + "/first"));
    await repository.seed(
      "INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,git_capability,github_capability,worktree_policy,preferred_worker_id) VALUES(" +
        [
          project,
          literal(ownerId),
          json(label("project")),
          "'managed-folder'",
          "'external'",
          false,
          false,
          "'direct'",
          worker,
        ].join(",") +
        ")",
    );
    await repository.seed(
      "INSERT INTO browsers(id,project_id,protected_label,protected_state) VALUES(" +
        [id, project, title, initial].join(",") +
        ")",
    );
    await repository.seed(
      "INSERT INTO remote_surfaces(id,project_id,worker_id,kind,configuration,protected_label,protected_state,state_revision) VALUES(" +
        [
          id,
          project,
          worker,
          "'browser'",
          json(remoteSurfaceConfigurationSchema.parse({ kind: "browser" })),
          title,
          initial,
          1,
        ].join(",") +
        ")",
    );
  } finally {
    await repository.close();
  }

  await launchCore(port);
  await launchWorker();
  const first = new BrowserSocket();
  await first.ready();
  assert.equal(await first.title("Native first page"), origin + "/first");
  const screenshot = await first.next(
    (value) => value.header?.channel === "frame",
  );
  assert.deepEqual(
    [...(await first.clear(screenshot)).slice(0, 2)],
    [0xff, 0xd8],
  );
  const operationId = randomUUID();
  const navigation = {
    type: "navigate",
    operationId,
    stateProtection: await location(
      "browser-operation",
      origin + "/second",
      operationId,
    ),
  };
  await first.send(navigation, { invalid: true });
  await first.send(navigation);
  assert.equal(await first.title("Native second page"), origin + "/second");
  await first.send(navigation);
  const second = new BrowserSocket();
  await second.ready();
  assert.equal(await second.title("Native second page"), origin + "/second");
  assert.equal(
    visits.filter((url) => url === "/second").length,
    1,
    "Replayed operation did not navigate",
  );
  assert.notEqual(first.attachment, second.attachment);
  first.socket.close();
  await once(first.socket, "close");

  await second.send({
    type: "pointer",
    event: "down",
    x: 30,
    y: 20,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await second.send({
    type: "pointer",
    event: "up",
    x: 30,
    y: 20,
    button: "left",
    clickCount: 1,
  });
  await second.send({
    type: "key",
    event: "down",
    key: "A",
    code: "KeyA",
    text: "A",
  });
  await second.send({
    type: "clipboard",
    operation: "paste-text",
    text: " & private",
  });
  await second.send({ type: "viewport", viewport });
  assert.equal(await second.title("A & private"), origin + "/second");
  await call("POST", "/api/remote-surfaces/" + surfaceId + "/suspend", 200, {});
  await call("POST", "/api/remote-surfaces/" + surfaceId + "/resume", 200, {});
  await second.send({ type: "viewport", viewport });
  assert.equal(await second.title("A & private"), origin + "/second");
  second.socket.close();
  await once(second.socket, "close");
  await call("DELETE", "/api/browsers/" + surfaceId, 204);
  console.log(
    JSON.stringify({ suite: "native-browser-surface", passed: true }),
  );
} catch (error) {
  console.error(logs, core?.diagnostics());
  throw error;
} finally {
  for (const { socket } of clients) socket.terminate();
  componentKey.fill(0);
  master.fill(0);
  try {
    await stopWorker();
  } finally {
    try {
      await core?.close();
    } finally {
      target.closeAllConnections();
      await new Promise((resolve) => target.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  }
}
