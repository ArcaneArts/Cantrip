// Real Core, native worker, and a disposable guest from an existing image.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { fixtureEnvironment, startServer } from "../server-rust/process.mjs";

const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    worker: { type: "string" },
    server: { type: "string" },
    image: { type: "string", default: "cantrip-os:dev" },
  },
});
assert.ok(values.worker && values.server);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-rust-os-workspaces-"));
const name = `cantrip-rust-os-${randomUUID()}`;
const workerId = "native-os-workspaces";
const data = path.join(root, "worker");
const trace = path.join(root, "guest-create.log");
let container, server, worker;

async function docker(...args) {
  return (await execute("docker", args, { timeout: 20_000 })).stdout.trim();
}

async function eventually(check) {
  const deadline = Date.now() + 25_000;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await delay(100);
  }
}

async function stopWorker() {
  if (!worker) return;
  const running = worker;
  worker = undefined;
  if (running.child.exitCode === null && running.child.signalCode === null)
    running.child.stdin.end();
  const timer = setTimeout(() => running.child.kill("SIGKILL"), 15_000);
  try {
    assert.equal(await running.done, 0, running.diagnostics());
  } finally {
    clearTimeout(timer);
  }
}

try {
  container = await docker(
    "run",
    "-d",
    "--rm",
    "--pull=never",
    "--network",
    "none",
    "--name",
    name,
    "--shm-size=256m",
    values.image,
  );
  assert.match(container, /^[a-f0-9]{64}$/u);
  const guest = async (...args) =>
    JSON.parse(await docker("exec", "--user", "0", container, ...args));
  const original = await eventually(async () => {
    const status = await guest("cantrip-executor", "status");
    assert.equal(status.service, "running");
    assert.equal(status.attachment, null);
    return status;
  });

  const environment = fixtureEnvironment(path.join(root, "server"));
  delete environment.CANTRIP_WORKER_TOKEN;
  environment.CANTRIP_BOOTSTRAP_MODE = "standalone";
  server = await startServer(
    path.resolve(values.server),
    ["--database", "pglite", "--port", "0", "--shutdown-on-stdin-close"],
    { cwd: root, env: environment },
  );
  const call = async (method, url, body, expected = 200) => {
    const response = await fetch(server.origin + url, {
      method,
      signal: AbortSignal.timeout(25_000),
      headers: {
        origin: "http://127.0.0.1:5173",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${url} ${text}`);
    return JSON.parse(text);
  };
  const enrollment = await call(
    "POST",
    "/api/workers/enrollment-codes",
    {
      label: "Native CantripOS workspaces smoke",
      expiresInSeconds: 300,
    },
    201,
  );
  const bin = path.join(root, "bin");
  await mkdir(bin);
  // Dispatch the actual guest mutation, then simulate the loss of its receipt.
  // The worker PATH contains only the Docker carrier and no Node executable.
  await writeFile(
    path.join(bin, "docker"),
    `#!/bin/sh
if [ "$1" = exec ] && [ "$7" = /usr/bin/cantrip-workspaces ] && [ "$8" = create ]; then
  printf '%s\\n' "$9" >> "$CANTRIP_TEST_CREATE_TRACE"
  if [ "$9" = uncertain ]; then
    "$CANTRIP_TEST_DOCKER_CLI" "$@" >/dev/null || exit "$?"
    exit 17
  fi
fi
exec "$CANTRIP_TEST_DOCKER_CLI" "$@"
`,
    { mode: 0o755 },
  );
  const dockerPath = (await execute("which", ["docker"])).stdout.trim();
  async function startWorker(code) {
    let diagnostics = "";
    const child = spawn(
      path.resolve(values.worker),
      ["--shutdown-on-stdin-close"],
      {
        cwd: root,
        env: {
          ...environment,
          PATH: bin,
          CANTRIP_TEST_CREATE_TRACE: trace,
          CANTRIP_TEST_DOCKER_CLI: dockerPath,
          CANTRIP_WORKER_DATA_DIR: data,
          CANTRIP_WORKER_ID: workerId,
          CANTRIP_SERVER_URL: server.origin,
          ...(code ? { CANTRIP_WORKER_ENROLLMENT_CODE: code } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const capture = (bytes) => {
      diagnostics = `${diagnostics}${bytes}`.slice(-32_768);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    worker = {
      child,
      done: new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      }),
      diagnostics: () => diagnostics,
    };
    await eventually(async () => {
      await call("GET", `/api/workers/${workerId}/version`);
    });
  }
  await startWorker(enrollment.code);

  const transport = { kind: "docker", container: name };
  const inspect = () =>
    call("POST", "/api/cantrip-os/inspect", { workerId, transport });
  const observed = await inspect();
  assert.equal(observed.guestInstanceId, original.instance_id);
  assert.equal(observed.runtimeGeneration, original.generation);
  assert.equal(observed.attachment, null);
  assert.deepEqual(observed.powerTarget, {
    kind: "docker",
    containerId: container,
  });
  const { instance: os } = await call("POST", "/api/cantrip-os/attach", {
    workerId,
    transport,
    guestInstanceId: observed.guestInstanceId,
    name: "Disposable CantripOS",
    expectedAttachmentGeneration: null,
  });
  const attached = await guest("cantrip-executor", "status");
  assert.deepEqual(attached.attachment, {
    owner_id: os.ownerId,
    worker_id: workerId,
  });

  const workspaceUrl = `/api/cantrip-os/${os.id}/workspaces`;
  const create = (request, expected) =>
    call("POST", workspaceUrl, request, expected);
  const request = {
    operationId: randomUUID(),
    guestWorkspaceId: "rust-owned",
    attachmentGeneration: os.attachmentGeneration,
    runtimeGeneration: os.runtimeGeneration,
  };
  const created = await create(request);
  assert.equal(created.state, "ready", JSON.stringify(created));
  assert.deepEqual(await create(request), created);
  const actual = (await guest("cantrip-workspaces", "list")).find(
    (entry) => entry.id === "rust-owned",
  );
  assert.deepEqual(created.receipt.workspace, {
    guestWorkspaceId: actual.id,
    uid: actual.uid,
    gid: actual.gid,
    homeGuestPath: actual.home,
  });
  await create(
    {
      ...request,
      operationId: randomUUID(),
      guestWorkspaceId: "stale",
      runtimeGeneration: randomUUID(),
    },
    409,
  );

  const uncertain = {
    ...request,
    operationId: randomUUID(),
    guestWorkspaceId: "uncertain",
  };
  const unknown = await create(uncertain);
  assert.equal(unknown.state, "unknown");
  assert.match(unknown.error, /^OS delivery is unknown/u);
  assert.ok(
    (await guest("cantrip-workspaces", "list")).some(
      (entry) => entry.id === "uncertain",
    ),
  );
  await stopWorker();
  await startWorker();
  const outcome = await call(
    "POST",
    `/api/cantrip-os/${os.id}/workspace-operations/${uncertain.operationId}/observe`,
  );
  assert.deepEqual(outcome, unknown);
  assert.deepEqual(await create(uncertain), unknown);
  assert.equal(await readFile(trace, "utf8"), "rust-owned\nuncertain\n");
  assert.ok(
    (await inspect()).workspaces.some(
      (entry) => entry.guestWorkspaceId === "uncertain",
    ),
  );

  const bootstrap = await call("GET", "/api/bootstrap");
  const hash = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const key = hash([
    bootstrap.server.id,
    os.ownerId,
    workerId,
    os.id,
    os.guestInstanceId,
  ]);
  const file = path.join(
    data,
    "cantrip-os-operations",
    key,
    `${request.operationId}.json`,
  );
  const record = JSON.parse(await readFile(file, "utf8"));
  assert.equal(record.version, 1);
  assert.equal(
    record.admissionFingerprint,
    hash([
      "cantrip-os.workspaces.create",
      {
        guestWorkspaceId: request.guestWorkspaceId,
        transport,
      },
    ]),
  );
  assert.deepEqual(record.receipt, created.receipt);
  console.log(
    JSON.stringify({
      suite: "native-cantrip-os-workspaces",
      inspected: true,
      attached: true,
      newWorkspace: true,
      staleRejected: true,
      observedAfterRestart: true,
      uncertainNeverReplayed: true,
      nodeCompatibleJournal: true,
    }),
  );
} catch (error) {
  if (worker) console.error(worker.diagnostics());
  if (server) console.error(server.diagnostics());
  throw error;
} finally {
  try {
    await stopWorker();
  } finally {
    try {
      await server?.close();
    } finally {
      try {
        if (container) await docker("rm", "-f", container);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}
