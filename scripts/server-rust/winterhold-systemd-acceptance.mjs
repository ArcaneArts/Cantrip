// Local only: actual installer, systemd units, TLS proxy and native artifacts.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify, parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildProductionEnvironment,
  createProductionServerArchive,
  serializeSystemdEnvironment,
} from "../deploy-production.mjs";

const require = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
);
const WebSocket = require("ws");
const { values } = parseArgs({
  options: {
    image: { type: "string" },
    artifact: { type: "string" },
    "node-image": { type: "string" },
    "previous-native-image": { type: "string" },
    "systemd-image": { type: "string" },
    report: { type: "string" },
  },
});
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const evidence = path.dirname(path.resolve(values.report));
await mkdir(evidence, { recursive: true });
const execute = promisify(execFile);
const docker = async (...args) =>
  (
    await execute("docker", args, { maxBuffer: 32 * 1024 * 1024 })
  ).stdout.trim();
const prefix = "cantrip-winterhold-" + randomUUID().slice(0, 8);
const host = prefix + "-host",
  database = prefix + "-db",
  network = prefix + "-net";
const report = {
  suite: "winterhold-systemd-artifact",
  prefix,
  containers: [],
  network,
  modes: [],
  bootstrapObservations: [],
  completeReplacement: false,
};
await writeFile(
  path.join(evidence, "owned-runtime.json"),
  JSON.stringify({ prefix, host, database, network }, null, 2) + "\n",
  { mode: 0o600 },
);
const id = (label) =>
  createHash("sha256")
    .update(prefix + label)
    .digest("hex")
    .slice(0, 40);
const domain = "api.rehearsal.example",
  origin = "https://app.rehearsal.example";
const productionDirectory = path.join(root, "deploy/production");
const productionTarget = JSON.parse(
  await readFile(path.join(productionDirectory, "deploy.json"), "utf8"),
);
const caddyfile = (
  await readFile(path.join(productionDirectory, "Caddyfile"), "utf8")
).replace(`${productionTarget.apiDomain} {`, `${domain} {\n\ttls internal`);
const password = "local-fixture-password-only";
const pgPassword = randomBytes(24).toString("hex");
const baseSecrets = new Map(
  Object.entries({
    CANTRIP_ACTIVE_SECRET_ENCRYPTION_KEY_ID: "fixture",
    CANTRIP_ADMIN_EMAIL: "admin@rehearsal.example",
    CANTRIP_ADMIN_PASSWORD: password,
    CANTRIP_API_DOMAIN: domain,
    CANTRIP_APP_ORIGINS: origin,
    CANTRIP_METRICS_TOKEN: randomBytes(32).toString("hex"),
    CANTRIP_PUBLIC_ORIGIN: "https://" + domain,
    CANTRIP_SECRET_ENCRYPTION_KEYS: JSON.stringify({
      fixture: randomBytes(32).toString("base64"),
    }),
    DATABASE_URL: `postgresql://cantrip:${pgPassword}@${database}:5432/cantrip?sslmode=require`,
  }),
);
async function retry(operation, label) {
  let last;
  for (let attempt = 0; attempt < 180; attempt++) {
    try {
      return await operation();
    } catch (error) {
      last = error;
    }
    await delay(500);
  }
  throw new Error(label, { cause: last });
}
async function runHost(...args) {
  return docker("exec", host, ...args);
}
async function exportImage(image, label) {
  const inspected = JSON.parse(await docker("image", "inspect", image))[0];
  const name = prefix + "-export-" + label;
  await docker("create", "--name", name, inspected.Id);
  report.containers.push(name);
  const directory = path.join(evidence, label + "-distribution");
  await mkdir(directory);
  await docker("cp", name + ":/opt/cantrip/.", directory);
  const archive = path.join(evidence, label + ".tar.gz");
  createProductionServerArchive(directory, archive);
  const bytes = await readFile(archive);
  report[label] = {
    imageId: inspected.Id,
    architecture: inspected.Architecture,
    archive,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  if (label === "previousNative" || label === "native") {
    report[label].manifest = JSON.parse(
      await readFile(path.join(directory, "native-server.json"), "utf8"),
    );
  }
  return archive;
}
function nativeExecutableHash(artifact) {
  const binary = artifact.manifest.files.find(
    ({ path }) => path === "bin/cantrip-server",
  );
  assert.ok(binary, "native artifact manifest records its executable");
  return binary.sha256;
}
async function observeNativeExecutable(release, expectedHash) {
  const pid = await runHost(
    "systemctl",
    "show",
    "cantrip-server.service",
    "-p",
    "MainPID",
    "--value",
  );
  assert.match(pid, /^[1-9][0-9]*$/);
  const executable = `/opt/cantrip/releases/${release}/bin/cantrip-server`;
  const processExecutable = `/proc/${pid}/exe`;
  const observedExecutable = await runHost("readlink", processExecutable);
  let mappedExecutable = processExecutable;
  if (observedExecutable !== executable) {
    // Under Rosetta, /proc/PID/exe points to the interpreter. The map identifies
    // the input inode and can be hashed even if its on-disk path is replaced.
    const range = await runHost(
      "awk",
      "-v",
      `file=${executable}`,
      "$NF == file { print $1; exit }",
      `/proc/${pid}/maps`,
    );
    assert.match(range, /^[a-f0-9]+-[a-f0-9]+$/);
    mappedExecutable = `/proc/${pid}/map_files/${range}`;
    assert.equal(await runHost("readlink", mappedExecutable), executable);
  }
  const sha256 = (await runHost("sha256sum", mappedExecutable)).split(/\s+/)[0];
  assert.equal(sha256, expectedHash, "systemd runs the selected artifact");
  return { pid, observedExecutable, mappedExecutable, sha256 };
}
let port,
  certificateAuthority,
  cookies = new Map(),
  csrf;
function request(route, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port,
        servername: domain,
        path: route,
        method,
        agent: false,
        ca: certificateAuthority,
        rejectUnauthorized: true,
        headers: {
          host: domain,
          origin,
          cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          ...(csrf ? { "x-cantrip-csrf": csrf } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        for (const line of response.headers["set-cookie"] ?? []) {
          const pair = line.split(";")[0],
            at = pair.indexOf("=");
          cookies.set(pair.slice(0, at), pair.slice(at + 1));
        }
        response.on("data", (bytes) => chunks.push(bytes));
        response.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            if (body.csrfToken) csrf = body.csrfToken;
            if (route === "/api/bootstrap" && body.server)
              report.bootstrapObservations.push({
                status: response.statusCode,
                server: body.server,
              });
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body,
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error("Fixture HTTPS timeout")));
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function ok(route, options) {
  const result = await request(route, options);
  assert.equal(result.status, 200, route + ": " + JSON.stringify(result.body));
  return result;
}
async function ready() {
  return retry(async () => {
    port = Number((await docker("port", host, "443/tcp")).split(":").at(-1));
    assert.ok(port > 0, "Docker published the fixture HTTPS port");
    certificateAuthority ??= await runHost(
      "cat",
      "/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt",
    );
    return ok("/readyz");
  }, "service must serve HTTPS through Caddy");
}
async function live() {
  const socket = new WebSocket(`wss://127.0.0.1:${port}/api/live`, {
    handshakeTimeout: 10000,
    servername: domain,
    ca: certificateAuthority,
    rejectUnauthorized: true,
    headers: {
      host: domain,
      origin,
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    },
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    async function exchange(value, type) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Live timeout: " + type));
        }, 10000);
        const receive = (bytes) => {
          const frame = JSON.parse(bytes.toString());
          if (frame.type === type) {
            cleanup();
            resolve(frame);
          }
        };
        const cleanup = () => {
          clearTimeout(timer);
          socket.off("message", receive);
        };
        socket.on("message", receive);
        socket.send(JSON.stringify(value));
      });
    }
    const initialized = await exchange(
      {
        type: "initialize",
        protocolVersion: 1,
        client: {
          id: prefix,
          name: "Deployment rehearsal",
          version: "1",
          controlCapabilities: [],
        },
        resume: null,
      },
      "ready",
    );
    assert.equal(initialized.protocolVersion, 1);
    assert.match(initialized.serverEpoch, /^[a-f0-9-]{36}$/);
    const pong = await exchange({ type: "ping", nonce: prefix }, "pong");
    assert.equal(pong.nonce, prefix);
    return { upgraded: true, initialized: true, ping: true };
  } finally {
    socket.close(1000, "fixture complete");
  }
}
async function install(
  archive,
  release,
  environment,
  label,
  expectedFailure = false,
) {
  const directory = path.join(evidence, label);
  await mkdir(directory);
  for (const file of [
    "install.sh",
    "cantrip-server.service",
    "cantrip-migrate@.service",
  ])
    await writeFile(
      path.join(directory, file),
      await readFile(path.join(productionDirectory, file)),
    );
  await writeFile(path.join(directory, "Caddyfile"), caddyfile);
  await writeFile(
    path.join(directory, "production.env"),
    serializeSystemdEnvironment(environment),
    { mode: 0o600 },
  );
  await runHost("mkdir", "-p", "/root/cantrip-rehearsal/" + label);
  await docker(
    "cp",
    directory + "/.",
    host + ":/root/cantrip-rehearsal/" + label,
  );
  await docker(
    "cp",
    archive,
    host + ":/root/cantrip-rehearsal/" + label + "/server.tar.gz",
  );
  let failure;
  const started = Date.now();
  try {
    const result = await execute(
      "docker",
      [
        "exec",
        host,
        "bash",
        `/root/cantrip-rehearsal/${label}/install.sh`,
        release,
        `/root/cantrip-rehearsal/${label}/server.tar.gz`,
        `/root/cantrip-rehearsal/${label}`,
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    await writeFile(
      path.join(directory, "install.log"),
      result.stdout + result.stderr,
    );
  } catch (error) {
    failure = error;
    await writeFile(
      path.join(directory, "install.log"),
      (error.stdout ?? "") + (error.stderr ?? ""),
    );
  }
  assert.equal(
    Boolean(failure),
    expectedFailure,
    label + (failure ? ": " + failure.message : " unexpectedly succeeded"),
  );
  return {
    label,
    release,
    durationMs: Date.now() - started,
    failed: Boolean(failure),
  };
}
try {
  let nativeArchive;
  if (values.artifact) {
    nativeArchive = path.join(evidence, "native.tar.gz");
    createProductionServerArchive(path.resolve(values.artifact), nativeArchive);
    const bytes = await readFile(nativeArchive);
    report.native = {
      artifact: path.resolve(values.artifact),
      manifest: JSON.parse(
        await readFile(path.join(values.artifact, "native-server.json")),
      ),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } else nativeArchive = await exportImage(values.image, "native");
  const previousNativeArchive = await exportImage(
    values["previous-native-image"],
    "previousNative",
  );
  const nodeArchive = await exportImage(values["node-image"], "node");
  const nativeHash = nativeExecutableHash(report.native);
  const previousNativeHash = nativeExecutableHash(report.previousNative);
  const systemdImage = JSON.parse(
    await docker("image", "inspect", values["systemd-image"]),
  )[0];
  report.systemdImage = {
    id: systemdImage.Id,
    architecture: systemdImage.Architecture,
  };
  await docker("network", "create", network);
  await docker(
    "run",
    "--detach",
    "--name",
    database,
    "--network",
    network,
    "-e",
    "POSTGRES_USER=cantrip",
    "-e",
    "POSTGRES_DB=cantrip",
    "-e",
    `POSTGRES_PASSWORD=${pgPassword}`,
    "--entrypoint",
    "sh",
    "postgres:18",
    "-c",
    "openssl req -x509 -nodes -newkey rsa:2048 -keyout /tmp/server.key -out /tmp/server.crt -days 1 -subj /CN=fixture >/dev/null 2>&1 && chown postgres:postgres /tmp/server.key /tmp/server.crt && chmod 0600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key",
  );
  report.containers.push(database);
  await retry(async () => {
    const result = await docker(
      "exec",
      database,
      "psql",
      "-U",
      "cantrip",
      "-d",
      "cantrip",
      "-Atc",
      "select 1",
    );
    assert.equal(result, "1");
  }, "PostgreSQL fixture");
  await docker(
    "run",
    "--detach",
    "--name",
    host,
    "--privileged",
    "--cgroupns",
    "private",
    "--network",
    network,
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/run/lock",
    "--tmpfs",
    "/tmp",
    "-p",
    "127.0.0.1::443",
    systemdImage.Id,
  );
  report.containers.push(host);
  await retry(
    () => runHost("systemd-run", "--wait", "--pipe", "/bin/true"),
    "real systemd must execute services",
  );
  report.pid1 = await runHost("cat", "/proc/1/comm");
  assert.equal(report.pid1, "systemd");
  for (const mode of ["pglite", "bundled-postgres", "postgres"]) {
    cookies = new Map();
    csrf = undefined;
    const environment = buildProductionEnvironment(baseSecrets, {
      apiDomain: domain,
    });
    environment.CANTRIP_DATA_DIR = "/var/lib/cantrip/" + mode;
    if (mode !== "postgres") {
      delete environment.DATABASE_URL;
      environment.CANTRIP_DATABASE_MODE = mode;
    }
    const baseline = id(mode + "base"),
      upgraded = id(mode + "native");
    const baselineArchive =
      mode === "postgres" ? nodeArchive : previousNativeArchive;
    const steps = [];
    const nativeExecutables = {};
    steps.push(
      await install(baselineArchive, baseline, environment, mode + "-baseline"),
    );
    await ready();
    if (mode !== "postgres")
      nativeExecutables.baseline = await observeNativeExecutable(
        baseline,
        previousNativeHash,
      );
    const login = await ok("/api/auth/login", {
      method: "POST",
      body: { email: baseSecrets.get("CANTRIP_ADMIN_EMAIL"), password },
    });
    assert.ok(
      login.headers["set-cookie"].some(
        (value) => /; Secure/i.test(value) && /; HttpOnly/i.test(value),
      ),
    );
    const identity = (await ok("/api/bootstrap")).body.server.id;
    await ok("/api/settings", { method: "PATCH", body: { theme: "dark" } });
    steps.push(
      await install(nativeArchive, upgraded, environment, mode + "-upgrade"),
    );
    const dependency = (await ready()).body.database;
    nativeExecutables.upgrade = await observeNativeExecutable(
      upgraded,
      nativeHash,
    );
    assert.equal(dependency.engine, mode === "pglite" ? "pglite" : "postgres");
    assert.equal((await ok("/api/settings")).body.preferences.theme, "dark");
    assert.equal((await ok("/api/bootstrap")).body.server.id, identity);
    const websocket = await live();
    const cors = await ok("/api/auth/session");
    assert.equal(cors.headers["access-control-allow-origin"], origin);
    assert.equal(
      (
        await request("/api/auth/session", {
          headers: { origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/api/settings", {
          method: "PATCH",
          body: { theme: "system" },
          headers: { "x-cantrip-csrf": "" },
        })
      ).status,
      403,
    );
    assert.equal((await ok("/api/settings")).body.preferences.theme, "dark");
    await ok("/api/settings", { method: "PATCH", body: { theme: "light" } });
    // Every fault executes the actual native CLI, with a deliberately invalid
    // argument at the named boundary. The successful migration path is real.
    for (const phase of ["migration", "startup"]) {
      const broken = path.join(evidence, mode + "-bad-" + phase);
      const brokenRelease = id(mode + phase);
      const faultArgument = `--fixture-invalid-${phase}-${mode}`;
      await mkdir(broken);
      for (const [file, arg] of [
        ["migrate.sh", phase === "migration" ? faultArgument : ""],
        ["start.sh", phase === "startup" ? faultArgument : ""],
      ]) {
        const launcher = path.join(broken, file);
        await writeFile(
          launcher,
          `#!/bin/sh\nexec /opt/cantrip/releases/${upgraded}/${file} ${arg} "$@"\n`,
        );
        // The evidence directory may be created under a restrictive umask.
        // The installed launchers must also execute as the service account.
        await chmod(launcher, 0o755);
      }
      const archive = broken + ".tar.gz";
      createProductionServerArchive(broken, archive);
      const changed = {
        ...environment,
        CANTRIP_METRICS_TOKEN: randomBytes(32).toString("hex"),
      };
      const exhaustStartLimit = mode === "pglite" && phase === "startup";
      const override =
        "/run/systemd/system/cantrip-server.service.d/qa-start-limit.conf";
      if (exhaustStartLimit) {
        // A failed launch consumes the entire budget before the installer
        // restores the working service. Exercise the real systemd limiter.
        await runHost("mkdir", "-p", path.posix.dirname(override));
        await runHost(
          "sh",
          "-c",
          'printf "%s\n" "$2" > "$1"',
          "sh",
          override,
          "[Unit]\nStartLimitIntervalSec=5min\nStartLimitBurst=1",
        );
        await runHost("systemctl", "daemon-reload");
        await runHost("systemctl", "reset-failed", "cantrip-server.service");
      }
      const failedInstall = await install(
        archive,
        brokenRelease,
        changed,
        mode + "-fault-" + phase,
        true,
      );
      const faultUnit =
        phase === "migration"
          ? `cantrip-migrate@${brokenRelease}.service`
          : "cantrip-server.service";
      const faultMessage = `unexpected argument '${faultArgument}' found`;
      const faultJournal = await runHost(
        "journalctl",
        "--unit",
        faultUnit,
        "--output=cat",
        "--no-pager",
        `--grep=${faultMessage}`,
      );
      assert.ok(faultJournal.includes(faultMessage));
      steps.push({ ...failedInstall, faultUnit, faultMessage });
      if (exhaustStartLimit) {
        assert.match(
          await runHost(
            "journalctl",
            "--unit",
            "cantrip-server.service",
            "--output=cat",
            "--no-pager",
            "--grep=Start request repeated too quickly",
          ),
          /Start request repeated too quickly/,
        );
        await runHost("rm", override);
        await runHost("systemctl", "daemon-reload");
        report.startLimitRecoveryObserved = true;
      }
      await ready();
      assert.equal(
        await runHost("readlink", "-f", "/opt/cantrip/current"),
        "/opt/cantrip/releases/" + upgraded,
      );
      assert.equal(
        await runHost("cat", "/etc/cantrip/production.env"),
        serializeSystemdEnvironment(environment).trim(),
      );
      assert.equal((await ok("/api/settings")).body.preferences.theme, "light");
    }
    // Code rollback opens the latest database, including the Rust write.
    steps.push(
      await install(baselineArchive, baseline, environment, mode + "-rollback"),
    );
    await ready();
    if (mode !== "postgres") {
      nativeExecutables.rollback = await observeNativeExecutable(
        baseline,
        previousNativeHash,
      );
      assert.notEqual(
        nativeExecutables.rollback.sha256,
        nativeExecutables.upgrade.sha256,
        "rollback executes a distinct native release",
      );
    }
    assert.equal((await ok("/api/settings")).body.preferences.theme, "light");
    assert.equal((await ok("/api/bootstrap")).body.server.id, identity);
    await ok("/api/settings", { method: "PATCH", body: { theme: "system" } });
    steps.push(
      await install(
        nativeArchive,
        upgraded,
        environment,
        mode + "-return-native",
      ),
    );
    await ready();
    nativeExecutables.returnNative = await observeNativeExecutable(
      upgraded,
      nativeHash,
    );
    assert.equal((await ok("/api/settings")).body.preferences.theme, "system");
    const { pid, observedExecutable: executable } =
      nativeExecutables.returnNative;
    const commandLine = await runHost("cat", `/proc/${pid}/cmdline`);
    assert.match(commandLine, /cantrip-server/);
    await runHost("test", "!", "-e", "/opt/cantrip/current/runtime/node");
    assert.notEqual(await runHost("stat", "-c", "%u", `/proc/${pid}`), "0");
    const group = await runHost(
      "systemctl",
      "show",
      "cantrip-server.service",
      "-p",
      "ControlGroup",
      "--value",
    );
    const ownedPids = (
      await runHost("cat", "/sys/fs/cgroup" + group + "/cgroup.procs")
    )
      .split(/\s+/)
      .filter(Boolean);
    assert.ok(ownedPids.includes(pid));
    await runHost("systemctl", "stop", "cantrip-server.service");
    assert.equal(
      await runHost(
        "systemctl",
        "show",
        "cantrip-server.service",
        "-p",
        "ExecMainStatus",
        "--value",
      ),
      "0",
    );
    for (const ownedPid of ownedPids) {
      assert.match(ownedPid, /^\d+$/);
      await runHost("test", "!", "-e", "/proc/" + ownedPid);
    }
    await runHost("systemctl", "start", "cantrip-server.service");
    await ready();
    assert.equal((await ok("/api/settings")).body.preferences.theme, "system");
    report.modes.push({
      mode,
      identity,
      dependency,
      websocket,
      sessionSurvived: true,
      restartAndChildrenReaped: true,
      executable,
      nativeExecutables,
      ownedPids,
      rollbackRuntime: mode === "postgres" ? "node" : "rust",
      steps,
    });
  }
  report.caddyCaSha256 = createHash("sha256")
    .update(certificateAuthority)
    .digest("hex");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = {
    message: error.message,
    stack: error.stack,
    cause: error.cause?.message,
  };
  process.exitCode = 1;
} finally {
  for (const name of report.containers) {
    try {
      await writeFile(
        path.join(evidence, name + ".inspect.json"),
        await docker("inspect", name),
      );
      const result = await execute("docker", ["logs", name], {
        maxBuffer: 32 * 1024 * 1024,
      });
      await writeFile(
        path.join(evidence, name + ".log"),
        result.stdout + result.stderr,
      );
    } catch {
      /* preserve the original failure */
    }
  }
  if (report.containers.includes(host)) {
    for (const [label, args] of [
      ["journal", ["journalctl", "--no-pager", "-o", "short-iso"]],
      ["processes", ["ps", "-ef"]],
      ["units", ["systemctl", "show", "cantrip-server.service"]],
    ])
      try {
        await writeFile(
          path.join(evidence, label + ".log"),
          await runHost(...args),
        );
      } catch {}
  }
  // Keep isolated containers/data until their evidence has been archived.
  await writeFile(values.report, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      report: values.report,
      passed: report.passed,
      error: report.error?.message,
      prefix,
    }),
  );
}
