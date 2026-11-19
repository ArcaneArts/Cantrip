// Real Core and native worker with a disposable encrypted browser surface.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { BrowserWorkerLink } from "./browser-worker-link-client.mjs";

const { values } = parseArgs({
  options: {
    ...Object.fromEntries(
      ["server", "worker", "repository", "chromium", "route"].map((name) => [
        name,
        { type: "string" },
      ]),
    ),
    recover: { type: "boolean" },
  },
});
assert.ok(
  values.server && values.worker && values.repository && values.chromium,
);
const route = values.route ?? "legacy";
assert.ok(["legacy", "relay", "local", "lan"].includes(route));
const WebSocket = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("ws");
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-native-browser-surface-"),
);
const workerDirectory = path.join(root, "worker");
const dataDirectory = path.join(root, "core");
const blockedLaunch = path.join(root, "reject-chromium-launch");
const chromium = values.recover
  ? path.join(root, "chromium-fixture")
  : path.resolve(values.chromium);
const environment = {
  ...fixtureEnvironment(dataDirectory),
  CANTRIP_BOOTSTRAP_MODE: "standalone",
};
if (route === "lan") environment.CANTRIP_WORKER_LINK_LAN_ENABLED = "true";
delete environment.CANTRIP_WORKER_TOKEN;
const ownerId = localOwner;
const workerId = "native-browser-surface-worker";
const projectId = "browser-surface-fixture-project";
const surfaceId = "native-browser-surface-fixture";
const siblingId = "native-browser-recovery-sibling";
const sharedProfile = "fixture shared browser profile";
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
    {
      "/second": "Native second page",
      "/sibling": "Shared profile sibling",
    }[request.url] ?? "Native first page";
  response.writeHead(200, { "content-type": "text/html" });
  response.end(
    "<!doctype html><title>" +
      title +
      '</title><canvas width="640" height="480" style="position:absolute;inset:0"></canvas><input autofocus style="position:absolute;left:8px;top:8px" oninput="document.title=this.value">' +
      `<script>
        if (${Boolean(values.recover)} && location.pathname === '/second') {
          const input = document.querySelector('input');
          const retained = localStorage.getItem('fixture-input');
          if (retained) input.value = document.title = retained;
          input.addEventListener('input', () => localStorage.setItem('fixture-input', input.value));
        }
        const ctx = document.querySelector('canvas').getContext('2d');
        const image = ctx.createImageData(640, 480);
        let state = 12345;
        for (let index = 0; index < image.data.length; index += 4) {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          image.data[index] = (state >>> 16) & 255;
          image.data[index + 1] = (state >>> 8) & 255;
          image.data[index + 2] = state & 255;
          image.data[index + 3] = 255;
        }
        ctx.putImageData(image, 0, 0);
      </script>`,
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
        CANTRIP_CHROMIUM_EXECUTABLE: chromium,
        CANTRIP_FIXTURE_CHROMIUM: path.resolve(values.chromium),
        CANTRIP_FIXTURE_BLOCK_LAUNCH: blockedLaunch,
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

function privateContext(resource, operationId = null, id = surfaceId) {
  return {
    serverId: browserIdentity,
    resource,
    resourceId: id,
    operationId,
    recordKind: "browser-state",
  };
}

function location(resource, url, operationId = null, id = surfaceId) {
  return encryptSurfacePrivateState({
    ownerId,
    keyRevision,
    componentKey,
    context: privateContext(resource, operationId, id),
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
  received = new Map();

  constructor(id = surfaceId) {
    this.id = id;
  }

  async connect() {
    clients.push(this);
    if (route !== "legacy") {
      this.link = await BrowserWorkerLink.connect({
        origin: core.origin,
        call,
        workerId,
        surfaceId: this.id,
        viewport,
        route,
        onFrame: (frame) => this.push(frame),
      });
      this.attachment = this.link.attachment;
      return;
    }
    this.socket = new WebSocket(
      core.origin.replace(/^http/u, "ws") +
        "/api/remote-surfaces/" +
        this.id +
        "/connect?width=640&height=480",
      { origin: "http://127.0.0.1:5173" },
    );
    this.socket.on("message", (packet, binary) => {
      this.push(
        binary
          ? decodeRemoteSurfaceFrame(packet)
          : JSON.parse(packet.toString()),
      );
    });
    this.socket.on("error", (error) =>
      this.inbox.push({ type: "error", message: error.message }),
    );
  }

  push(value) {
    this.inbox.push(value);
    if (this.inbox.length > 128) this.inbox.shift();
  }

  async close() {
    if (this.link) return this.link.close();
    this.socket.close();
    await once(this.socket, "close");
  }

  terminate() {
    if (this.link) return this.link.terminate();
    this.socket?.terminate();
  }

  context(header, direction) {
    const { attachmentId, channel, sequence } = header;
    return {
      serverId: browserIdentity,
      surfaceKind: "browser",
      surfaceId: this.id,
      attachmentId,
      direction,
      channel,
      sequence,
    };
  }

  async next(select) {
    const limit = Date.now() + 12_000;
    while (Date.now() < limit) {
      if (this.link?.failure) throw this.link.failure;
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
    await this.connect();
    if (!this.link) {
      const value = await this.next((value) => value.type === "ready");
      assert.equal(value.transport, "websocket");
      assert.equal(value.surfaceId, this.id);
      this.attachment = value.attachmentId;
    }
    await this.send({ type: "viewport", viewport });
  }

  async send(message, { invalid = false } = {}) {
    const header = {
      protocolVersion: 1,
      surfaceId: this.id,
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
    const frame = encodeRemoteSurfaceFrame(header, payload);
    if (this.link) await this.link.send(frame);
    else this.socket.send(frame);
  }

  async clear(value) {
    assert.equal(value.header.surfaceId, this.id);
    assert.equal(value.header.attachmentId, this.attachment);
    const { sequence, channel } = value.header;
    assert.ok(
      sequence > (this.received.get(channel) ?? -1),
      "Surface counters survive browser recovery",
    );
    this.received.set(channel, sequence);
    return decryptRemoteSurfaceStreamPayload({
      ownerId,
      componentKey,
      keyRevision,
      protectedPayload: value.payload,
      context: this.context(value.header, "worker-to-client"),
    });
  }

  async runtime(status) {
    await this.next(async (value) => {
      if (value.header?.channel !== "control") return false;
      const message = JSON.parse(
        Buffer.from(await this.clear(value)).toString(),
      );
      return message.type === "browser-runtime" && message.status === status;
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
        context: privateContext(
          "browser-operation",
          message.operationId,
          this.id,
        ),
        opaque: message.stateProtection,
      });
      return true;
    });
    return state.url;
  }
}

async function chromiumEndpoint() {
  const digest = createHash("sha256").update(sharedProfile).digest("hex");
  const [port, endpoint] = (
    await readFile(
      path.join(
        workerDirectory,
        "browser",
        "profiles",
        digest,
        "DevToolsActivePort",
      ),
      "utf8",
    )
  )
    .trim()
    .split("\n");
  assert.match(port, /^\d+$/u);
  assert.match(endpoint, /^\/devtools\/browser\/[0-9a-f-]+$/u);
  const base = "127.0.0.1:" + port;
  const list = await fetch("http://" + base + "/json/list", {
    signal: AbortSignal.timeout(2000),
  });
  return { endpoint: "ws://" + base + endpoint, pages: await list.json() };
}

async function stopFixtureChromium(endpoint) {
  const socket = new WebSocket(endpoint);
  try {
    await once(socket, "open", { signal: AbortSignal.timeout(3000) });
    const closed = once(socket, "close", { signal: AbortSignal.timeout(6000) });
    socket.send(JSON.stringify({ id: 1, method: "Browser.close", params: {} }));
    await closed;
  } finally {
    socket.terminate();
  }
}

async function verifyRecovery(view) {
  const sibling = new BrowserSocket(siblingId);
  await sibling.ready();
  assert.equal(
    await sibling.title("Shared profile sibling"),
    origin + "/sibling",
  );
  const original = await chromiumEndpoint();
  for (const address of ["/second", "/sibling"]) {
    assert.ok(original.pages.some(({ url }) => url === origin + address));
  }
  await writeFile(blockedLaunch, "");
  await stopFixtureChromium(original.endpoint);
  await Promise.all([
    view.runtime("recovering"),
    sibling.runtime("recovering"),
  ]);
  await eventually(
    () => logs.includes("browser.runtime.start-failed"),
    (value) => assert.ok(value),
    8000,
  );
  await rm(blockedLaunch);
  await Promise.all([view.runtime("ready"), sibling.runtime("ready")]);
  assert.equal(await view.title("A & private"), origin + "/second");
  assert.equal(
    await sibling.title("Shared profile sibling"),
    origin + "/sibling",
  );
  const reopened = await chromiumEndpoint();
  assert.notEqual(reopened.endpoint, original.endpoint);
  for (const address of ["/second", "/sibling"]) {
    assert.ok(reopened.pages.some(({ url }) => url === origin + address));
  }
  const targets = reopened.pages.filter(
    ({ url }) => url === origin + "/second",
  );
  assert.equal(
    targets.length,
    1,
    "A single live target was restored for the first surface",
  );
  const pageEndpoint = new URL(targets[0].webSocketDebuggerUrl);
  assert.equal(pageEndpoint.origin, new URL(reopened.endpoint).origin);
  assert.match(pageEndpoint.pathname, /^\/devtools\/page\//u);
  const crashed = new WebSocket(pageEndpoint);
  try {
    await once(crashed, "open", { signal: AbortSignal.timeout(3000) });
    const notice = once(crashed, "message", {
      signal: AbortSignal.timeout(4000),
    });
    crashed.send(JSON.stringify({ id: 1, method: "Page.crash", params: {} }));
    const [reply] = await notice;
    const { method, error } = JSON.parse(reply.toString());
    assert.equal(method, "Inspector.targetCrashed", JSON.stringify(error));
    await view.runtime("recovering");
    await view.runtime("ready");
    assert.equal(await view.title("A & private"), origin + "/second");
  } finally {
    crashed.terminate();
  }
  const restored = await chromiumEndpoint();
  assert.equal(
    restored.endpoint,
    reopened.endpoint,
    "A renderer crash keeps the shared Chromium process",
  );
  assert.equal(
    restored.pages.filter(({ url }) => url === origin + "/second").length,
    1,
  );
  await sibling.send({ type: "viewport", viewport });
  assert.equal(
    await sibling.title("Shared profile sibling"),
    origin + "/sibling",
  );
  await view.send({ type: "clipboard", operation: "paste-text", text: "!" });
  await view.send({ type: "viewport", viewport });
  assert.equal(await view.title("A & private!"), origin + "/second");
  await sibling.close();
  await call("DELETE", "/api/browsers/" + siblingId, 204);
  await view.send({ type: "viewport", viewport });
  assert.equal(await view.title("A & private!"), origin + "/second");
}

try {
  if (values.recover) {
    await writeFile(
      chromium,
      `#!/bin/sh
[ ! -f "$CANTRIP_FIXTURE_BLOCK_LAUNCH" ] || exit 29
exec "$CANTRIP_FIXTURE_CHROMIUM" "$@"
`,
      { mode: 0o700 },
    );
  }
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
    const worker = literal(workerId);
    const title = json(label("browser"));
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
    const surfaces = [[surfaceId, "/first"]];
    if (values.recover) surfaces.push([siblingId, "/sibling"]);
    for (const [surface, address] of surfaces) {
      const id = literal(surface);
      const initial = json(
        await location("browser-row", origin + address, null, surface),
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
            json(
              remoteSurfaceConfigurationSchema.parse({
                kind: "browser",
                ...(values.recover ? { profileId: sharedProfile } : {}),
              }),
            ),
            title,
            initial,
            1,
          ].join(",") +
          ")",
      );
    }
  } finally {
    await repository.close();
  }

  await launchCore(port);
  await launchWorker();
  const advertised = (await call("GET", "/api/workers", 200)).find(
    (worker) => worker.workerId === workerId,
  );
  assert.equal(advertised.remoteSurfaces.browser, true);
  assert.deepEqual(advertised.remoteSurfaces.transports, ["websocket"]);
  const first = new BrowserSocket();
  await first.ready();
  assert.equal(await first.title("Native first page"), origin + "/first");
  const screenshot = await first.next(
    (value) =>
      value.header?.channel === "frame" && value.payload.byteLength > 64 * 1024,
  );
  const image = await first.clear(screenshot);
  assert.deepEqual([...image.slice(0, 2)], [0xff, 0xd8]);
  assert.ok(image.byteLength > 64 * 1024);
  if (first.link) {
    assert.ok(image.byteLength > first.link.initialCredit);
    assert.ok(first.link.fragmentedScreenshot);
  }
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
  await first.close();

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
  if (values.recover) await verifyRecovery(second);
  await second.close();
  await call("DELETE", "/api/browsers/" + surfaceId, 204);
  console.log(
    JSON.stringify({
      suite: "native-browser-surface",
      route,
      recovery: Boolean(values.recover),
      passed: true,
    }),
  );
} catch (error) {
  console.error(logs, core?.diagnostics());
  throw error;
} finally {
  await Promise.allSettled(clients.map((client) => client.terminate()));
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
