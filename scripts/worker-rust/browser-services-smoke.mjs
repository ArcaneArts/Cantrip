// Run discovery through the real server and Rust worker. The lsof wrapper
// limits the scan to listeners created by this development fixture.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { discoverBrowserServices } from "../../cantrip_worker/src/browser/service-discovery.ts";
import { remoteSurfaceConfigurationSchema } from "../../packages/protocol/dist/remote-surfaces.js";
import { eventually } from "../server-rust/full-worker.mjs";
import { fixtureEnvironment, startServer } from "../server-rust/process.mjs";
import {
  json,
  label,
  literal,
  localOwner,
  state,
} from "../server-rust/project-target-state.mjs";
import { repositoryFixture } from "../server-rust/repository-fixture.mjs";

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    worker: { type: "string" },
    repository: { type: "string" },
  },
});
assert.ok(
  values.server && values.worker && values.repository,
  "Pass the three linked binaries.",
);
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-native-browser-services-"),
);
const dataDirectory = path.join(root, "server");
const bin = path.join(root, "bin");
const environment = {
  ...fixtureEnvironment(dataDirectory),
  CANTRIP_BOOTSTRAP_MODE: "standalone",
};
const workerId = "native-browser-services";
const projectId = "browser-services-fixture";
const browserId = "browser-services-surface";
delete environment.CANTRIP_WORKER_TOKEN;
let core;
let worker;
let diagnostics = "";
const listeners = [];
const sockets = new Set();

async function listen(server) {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // Probing the TCP fixture with both protocols can reset either side.
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  listeners.push(server);
  return server.address().port;
}

async function startWorker(enrollmentCode) {
  const child = spawn(
    path.resolve(values.worker),
    ["--shutdown-on-stdin-close"],
    {
      cwd: root,
      env: {
        ...environment,
        PATH: bin,
        NO_COLOR: "1",
        CANTRIP_SERVER_URL: core.origin,
        CANTRIP_WORKER_DATA_DIR: path.join(root, "worker"),
        CANTRIP_WORKER_ID: workerId,
        ...(enrollmentCode
          ? { CANTRIP_WORKER_ENROLLMENT_CODE: enrollmentCode }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const completion = once(child, "exit");
  let ready = false;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-32_768);
      ready ||=
        diagnostics.includes("worker.connection.connected") ||
        diagnostics.includes("Worker command channel connected");
    });
  worker = { child, completion };
  await eventually(
    () => ({ ready, exit: child.exitCode, signal: child.signalCode }),
    ({ ready, exit, signal }) => {
      assert.equal(exit ?? signal, null, diagnostics);
      assert.ok(ready, diagnostics);
    },
    12_000,
  );
}

async function stopWorker() {
  if (!worker) return;
  const { child, completion } = worker;
  worker = undefined;
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
  try {
    const [status] = await completion;
    assert.equal(status, 0, diagnostics);
  } finally {
    clearTimeout(timer);
  }
}

async function openCore(port = 0) {
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

async function call(method, endpoint, body) {
  const response = await fetch(core.origin + endpoint, {
    method,
    signal: AbortSignal.timeout(22_000),
    headers: {
      origin: "http://127.0.0.1:5173",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  assert.equal(response.status, body ? 201 : 200, JSON.stringify(value));
  return value;
}

try {
  await mkdir(bin);
  const tool = (name) =>
    execFileSync("which", [name], { encoding: "utf8" }).trim();
  const quotedLsof = "'" + tool("lsof").replaceAll("'", "'\\''") + "'";
  await writeFile(
    path.join(bin, "lsof"),
    "#!/bin/sh\nexec " + quotedLsof + " -a -p " + process.pid + ' "$@"\n',
    { mode: 0o700 },
  );
  await symlink(tool("ps"), path.join(bin, "ps"));
  const key = path.join(root, "local.key");
  const cert = path.join(root, "local.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-x509",
      "-days",
      "1",
      "-subj",
      "/CN=cantrip-browser-fixture.invalid",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );

  let redirected = false;
  const httpPort = await listen(
    httpServer((request, response) => {
      if (request.url !== "/") {
        redirected = true;
        response.writeHead(204).end();
        return;
      }
      assert.equal(
        request.headers["user-agent"],
        "Cantrip-Service-Discovery/1.0",
      );
      assert.equal(request.headers["authorization"], undefined);
      assert.equal(request.headers["cookie"], undefined);
      response.writeHead(302, {
        location: "/disallowed",
        "content-type": "text/html",
      });
      const title = Buffer.from(
        "<TITLE>Cantrip &amp; 🧪 <i>fixture</i></TITLE>",
      );
      const split = title.indexOf(Buffer.from("🧪")) + 2;
      response.write(title.subarray(0, split));
      response.end(title.subarray(split));
    }),
  );
  const httpsPort = await listen(
    httpsServer(
      {
        key: await readFile(key),
        cert: await readFile(cert),
      },
      (_request, response) => {
        response.writeHead(401).end("<title>Private HTTPS fixture</title>");
      },
    ),
  );
  const nonHttpPort = await listen(
    tcpServer((socket) => socket.end("fixture TCP greeting\r\n")),
  );
  await openCore();
  const serverPort = Number(new URL(core.origin).port);
  const { code } = await call("POST", "/api/workers/enrollment-codes", {
    label: "Browser discovery fixture",
  });
  await startWorker(code);
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
    const browser = literal(browserId);
    const worker = literal(workerId);
    const placement = json(
      remoteSurfaceConfigurationSchema.parse({ kind: "browser" }),
    );
    const title = json(label("browser"));
    const initial = json(state("browser-state"));
    await repository.seed(
      "INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,git_capability,github_capability,worktree_policy,preferred_worker_id) VALUES(" +
        [
          project,
          literal(localOwner),
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
        [browser, project, title, initial].join(",") +
        ")",
    );
    await repository.seed(
      "INSERT INTO remote_surfaces(id,project_id,worker_id,kind,configuration,protected_label,protected_state,state_revision) VALUES(" +
        [
          browser,
          project,
          worker,
          "'browser'",
          placement,
          title,
          initial,
          1,
        ].join(",") +
        ")",
    );
  } finally {
    await repository.close();
  }

  await openCore(serverPort);
  diagnostics = "";
  await startWorker();
  const actual = await call("GET", "/api/browsers/" + browserId + "/services");
  const candidates = [httpPort, httpsPort, nonHttpPort].map((port) => ({
    host: "127.0.0.1",
    port,
    pid: process.pid,
    processName: "node",
    command: null,
  }));
  const reference = await discoverBrowserServices({ workerId, candidates });
  assert.deepEqual(actual, reference);
  assert.deepEqual(
    actual.map(({ port }) => port),
    [httpPort, httpsPort].sort((a, b) => a - b),
  );
  assert.equal(
    actual.find(({ port }) => port === httpPort).title,
    "Cantrip & 🧪 fixture",
  );
  assert.equal(actual.find(({ port }) => port === httpPort).statusCode, 302);
  assert.equal(actual.find(({ port }) => port === httpsPort).statusCode, 401);
  assert.equal(actual.find(({ port }) => port === httpsPort).protocol, "https");
  assert.equal(redirected, false);
  console.log(
    JSON.stringify({
      suite: "native-browser-services-discovery",
      passed: true,
    }),
  );
} catch (error) {
  console.error(diagnostics, core?.diagnostics());
  throw error;
} finally {
  try {
    await stopWorker();
  } finally {
    try {
      await core?.close();
    } finally {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        listeners.map(
          (server) => new Promise((resolve) => server.close(resolve)),
        ),
      );
      await rm(root, { recursive: true, force: true });
    }
  }
}
