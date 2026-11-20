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
import { verifyCantripOsDesktop } from "./cantrip-os-desktop-cases.mjs";
import {
  proxyPowerCarrier,
  verifyCantripOsPower,
} from "./cantrip-os-power-cases.mjs";

const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    worker: { type: "string" },
    server: { type: "string" },
    repository: { type: "string" },
    "executor-package": { type: "string" },
    "workspaces-package": { type: "string" },
    "recovery-package": { type: "string" },
    "package-artifact": { type: "string" },
    "run-plan": { type: "boolean", default: false },
    "run-runtime": { type: "boolean", default: false },
    "product-files": { type: "boolean", default: false },
    "guest-terminal": { type: "boolean", default: false },
    desktop: { type: "boolean", default: false },
    "backup-capture": { type: "boolean", default: false },
    power: { type: "boolean", default: false },
    linked: { type: "boolean", default: false },
    image: { type: "string", default: "cantrip-os:dev" },
  },
});
assert.ok(values.worker && values.server);
assert.ok(!values["guest-terminal"] || values.repository);
assert.ok(
  !values.linked || values.repository,
  "--linked uses the source fixture",
);
assert.ok(
  !values["executor-package"] || values.repository || values["backup-capture"],
  "--executor-package uses the source or backup fixture",
);
assert.ok(
  !(values["run-plan"] || values["run-runtime"] || values["product-files"]) ||
    values["executor-package"],
  "Guest file and Run cases use the upgraded executor",
);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-os-"));
const name = `cantrip-rust-os-${randomUUID()}`;
const workerId = "native-os-workspaces";
const data = path.join(root, "worker");
const packageCatalog = path.join(root, "catalogue");
const trace = path.join(root, "guest-create.log");
const backupTrace = path.join(root, "guest-backup.log");
const backupPublished = path.join(root, "backup-published");
const backupRelease = path.join(root, "backup-release");
let container, server, worker, powerProxy, realDockerHost;
const linked = values.linked
  ? { name, journals: [], volumes: [], operations: [] }
  : undefined;

async function docker(...args) {
  const timeout = values["backup-capture"] ? 120_000 : 20_000;
  return (await execute("docker", args, { timeout })).stdout.trim();
}

async function eventually(check, timeout = 25_000) {
  const deadline = Date.now() + timeout;
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

async function crashWorker() {
  const running = worker;
  assert.ok(running.child.kill("SIGKILL"));
  await running.done;
  assert.equal(running.child.signalCode, "SIGKILL");
  worker = undefined;
}

try {
  const managedVolumes = linked
    ? ["home", "workspaces", "executor"].map((volume) => name + "-" + volume)
    : [];
  linked?.volumes.push(...managedVolumes);
  container = await docker(
    "run",
    "-d",
    ...(linked
      ? [
          "--label",
          "io.cantrip.os=foundation",
          "--label",
          `io.cantrip.os.fixture=${name}`,
          "-v",
          managedVolumes[0] + ":/home/cantrip",
          "-v",
          managedVolumes[1] + ":/var/lib/cantrip-os-workspaces",
          "-v",
          managedVolumes[2] + ":/var/lib/cantrip-os-executor",
        ]
      : values.power
        ? []
        : ["--rm"]),
    "--pull=never",
    "--network",
    "none",
    "--name",
    name,
    "--shm-size=256m",
    values.image,
  );
  assert.match(container, /^[a-f0-9]{64}$/u);
  if (values.power) {
    realDockerHost =
      (!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST) ||
      (await docker(
        "context",
        "inspect",
        "--format",
        "{{.Endpoints.docker.Host}}",
      ));
    powerProxy = await proxyPowerCarrier(root, realDockerHost, name, container);
  }
  const guest = async (...args) =>
    JSON.parse(await docker("exec", "--user", "0", container, ...args));
  let original = await eventually(async () => {
    const status = await guest("cantrip-executor", "status");
    assert.equal(status.service, "running");
    assert.equal(status.attachment, null);
    return status;
  });
  async function installPackage(file, name) {
    const guestPackage = `/tmp/cantrip-os-${name}-test.deb`;
    await docker("cp", path.resolve(file), `${container}:${guestPackage}`);
    await docker("exec", "--user", "0", container, "dpkg", "-i", guestPackage);
    await docker("exec", "--user", "0", container, "unlink", guestPackage);
  }
  if (values["workspaces-package"]) {
    await installPackage(values["workspaces-package"], "workspaces");
  }
  if (values["executor-package"]) {
    await installPackage(values["executor-package"], "executor");
    const upgraded = await eventually(async () => {
      const status = await guest("cantrip-executor", "status");
      assert.equal(status.service, "running");
      return status;
    });
    assert.equal(upgraded.instance_id, original.instance_id);
    original = upgraded;
  }
  if (values["recovery-package"]) {
    await installPackage(values["recovery-package"], "recovery");
  }

  const environment = fixtureEnvironment(path.join(root, "server"));
  delete environment.CANTRIP_WORKER_TOKEN;
  environment.CANTRIP_BOOTSTRAP_MODE = "standalone";
  const start = () =>
    startServer(
      path.resolve(values.server),
      ["--database", "pglite", "--port", "0", "--shutdown-on-stdin-close"],
      { cwd: root, env: environment },
    );
  server = await start();
  const call = async (method, url, body, expected = 200) => {
    const response = await fetch(server.origin + url, {
      method,
      signal: AbortSignal.timeout(
        values.power ||
          values.desktop ||
          values["package-artifact"] ||
          values["backup-capture"]
          ? 180_000
          : 25_000,
      ),
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
  let sources, projects;
  if (values.repository) {
    sources = await import("./cantrip-os-sources-cases.mjs");
    await call("GET", "/api/bootstrap");
    await server.close();
    server = undefined;
    projects = await sources.seedProjects(
      values.repository,
      root,
      environment.CANTRIP_DATA_DIR,
    );
    server = await start();
  }
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
if [ -n "$CANTRIP_TEST_REAL_DOCKER_HOST" ]; then
  export DOCKER_HOST="$CANTRIP_TEST_REAL_DOCKER_HOST"
fi
if [ "$1" = exec ] && [ "$7" = /usr/bin/cantrip-workspaces ] && [ "$8" = create ]; then
  printf '%s\\n' "$9" >> "$CANTRIP_TEST_CREATE_TRACE"
  if [ "$9" = uncertain ]; then
    "$CANTRIP_TEST_DOCKER_CLI" "$@" >/dev/null || exit "$?"
    exit 17
  fi
fi
if [ -n "$CANTRIP_TEST_BACKUP_TRACE" ] && [ "$1" = exec ] && [ "$7" = /usr/bin/cantrip-recovery ]; then
  case "\${10}" in
    --expect-workspace)
      if [ "\${12}" = capture ]; then
        printf '%s\\n' "\${13}" >> "$CANTRIP_TEST_BACKUP_TRACE"
      fi
      ;;
    forget)
      printf '%s\\n' "\${11}" > "$CANTRIP_TEST_BACKUP_PUBLISHED"
      retry=0
      while [ ! -f "$CANTRIP_TEST_BACKUP_RELEASE" ] && [ "$retry" -lt 800 ]; do
        /bin/sleep 0.05
        retry=$((retry + 1))
      done
      exit 17
      ;;
  esac
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
          ...(values["backup-capture"]
            ? {
                CANTRIP_TEST_BACKUP_TRACE: backupTrace,
                CANTRIP_TEST_BACKUP_PUBLISHED: backupPublished,
                CANTRIP_TEST_BACKUP_RELEASE: backupRelease,
              }
            : {}),
          ...(values["package-artifact"]
            ? { CANTRIP_OS_PACKAGE_DIRECTORY: packageCatalog }
            : {}),
          ...(powerProxy
            ? {
                DOCKER_HOST: powerProxy.endpoint,
                DOCKER_CONTEXT: "",
                CANTRIP_TEST_REAL_DOCKER_HOST: realDockerHost,
              }
            : {}),
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
  let repositoryKey;
  if (sources) {
    repositoryKey = await sources.verifySources({
      call,
      projects,
      os,
      actual,
      workerId,
      data,
      bootstrap,
      hash,
      transport,
      container,
      docker,
      eventually,
      linked,
      runDefinitions: !!values["executor-package"],
      runPlan: values["run-plan"],
      runRuntime: values["run-runtime"],
      productFiles: values["product-files"],
      guestTerminal: values["guest-terminal"],
      origin: server.origin,
      stopWorker,
      crashWorker: async () => {
        await crashWorker();
        await startWorker();
      },
      restartWorker: async () => {
        await stopWorker();
        await startWorker();
      },
    });
  }
  if (values.desktop) {
    await verifyCantripOsDesktop({
      call,
      os,
      workspaceUrl,
      guestWorkspaceId: actual.id,
      observeGuest: () =>
        guest("cantrip-workspaces", "desktop-target", actual.id),
      journalDir: path.dirname(file),
      stopWorker,
      startWorker,
    });
  }
  if (powerProxy) {
    await verifyCantripOsPower({
      call,
      os,
      actual,
      docker,
      name,
      container,
      proxy: powerProxy,
      journalDir: path.dirname(file),
      eventually,
      restartWorker: async () => {
        await stopWorker();
        await startWorker();
      },
    });
  }
  if (values["backup-capture"]) {
    const { verifyCantripOsCapture } =
      await import("./cantrip-os-backup-cases.mjs");
    await verifyCantripOsCapture({
      call,
      workerId,
      data,
      repositoryKey,
      serverId: bootstrap.server.id,
      root,
      os,
      actual,
      workspaceUrl,
      docker,
      container,
      backupTrace,
      backupPublished,
      backupRelease,
      storageKey: key,
      eventually,
      crashWorker,
      startWorker,
    });
  }
  if (values["package-artifact"]) {
    const { verifyCantripOsPackages } =
      await import("./cantrip-os-packages-cases.mjs");
    await verifyCantripOsPackages({
      call,
      os,
      workerId,
      data,
      repositoryKey,
      serverId: bootstrap.server.id,
      file: values["package-artifact"],
      catalog: packageCatalog,
      guest: (...args) => docker("exec", "--user", "0", container, ...args),
      journalDir: path.dirname(file),
      eventually,
      restartWorker: async () => {
        await stopWorker();
        await startWorker();
      },
    });
  }
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
      ...(values.desktop ? { guestDesktopLifecycle: true } : {}),
      ...(powerProxy ? { retainedPowerControls: true } : {}),
      ...(values["package-artifact"] ? { guestPackageManagement: true } : {}),
      ...(values["backup-capture"] ? { encryptedGuestBackup: true } : {}),
    }),
  );
} catch (error) {
  if (worker) console.error(worker.diagnostics());
  if (server) console.error(server.diagnostics());
  if (values["executor-package"] && container) {
    const log = await docker(
      "exec",
      "--user",
      "0",
      container,
      "tail",
      "-n",
      "20",
      "/var/lib/cantrip-os-executor/rust-owned.log",
    ).catch(() => "");
    if (log) console.error(log);
  }
  throw error;
} finally {
  try {
    if (values["backup-capture"]) await writeFile(backupRelease, "");
    await stopWorker();
  } finally {
    try {
      await server?.close();
    } finally {
      try {
        if (linked) {
          const selectors = [
            `io.cantrip.os.fixture=${name}`,
            ...linked.operations.map((id) => `io.cantrip.os.cache-init=${id}`),
          ];
          for (const selector of selectors) {
            const owned = await docker(
              "ps",
              "-aq",
              "--filter",
              "label=" + selector,
            );
            for (const id of owned.split("\n").filter(Boolean))
              await docker("rm", "-f", "-v", id);
          }
          const present = new Set(
            (await docker("volume", "ls", "-q")).split("\n"),
          );
          for (const volume of linked.volumes)
            if (present.has(volume)) await docker("volume", "rm", volume);
          for (const journal of linked.journals) {
            try {
              const state = JSON.parse(await readFile(journal, "utf8"));
              if (state.snapshotImage)
                await docker("image", "rm", state.snapshotImage);
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
        } else if (container) {
          await docker("rm", "-f", "-v", container);
        }
      } finally {
        try {
          await powerProxy?.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }
}
