// Local container acceptance. The driver runs on the host; the runtime image
// contains neither Node nor repository sources/development dependencies.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { containerRuntimeIdentity } from "./container-runtime-identity.mjs";

const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    image: { type: "string" },
    architecture: { type: "string" },
    report: { type: "string" },
    "postgres-image": { type: "string", default: "postgres:18" },
  },
});
const docker = async (...args) =>
  (
    await execute("docker", args, { maxBuffer: 16 * 1024 * 1024 })
  ).stdout.trim();
const logs = async (name) => {
  const result = await execute("docker", ["logs", name], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout + result.stderr;
};
const prefix = "cantrip-native-package-" + randomUUID().slice(0, 8);
const network = prefix + "-network",
  pg = prefix + "-database";
const report = {
  suite: "native-container-artifact",
  image: values.image,
  prefix,
  modes: [],
};
const containers = [],
  volumes = [];
if (values.report)
  await mkdir(path.dirname(values.report), { recursive: true });
let networkCreated = false,
  failure;
const retry = async (operation, container) => {
  let last;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      let state;
      try {
        state = JSON.parse(await docker("inspect", container))[0].State;
      } catch {
        /* An observation error is not evidence of process termination. */
      }
      if (state && ["exited", "dead"].includes(state.Status))
        throw new Error(
          `Container ${container} exited (${state.ExitCode}):\n${await logs(container)}`,
          { cause: error },
        );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw last;
};
try {
  const inspected = JSON.parse(
    await docker("image", "inspect", values.image),
  )[0];
  const runtimeImage = inspected.Id;
  report.imageId = runtimeImage;
  report.architecture = inspected.Architecture;
  report.os = inspected.Os;
  const platform = `${inspected.Os}/${inspected.Architecture}`;
  await docker("network", "create", network);
  networkCreated = true;
  const pgVolume = prefix + "-database-data";
  await docker("volume", "create", pgVolume);
  volumes.push(pgVolume);
  await docker(
    "run",
    "--detach",
    "--name",
    pg,
    "--network",
    network,
    "-e",
    "POSTGRES_USER=cantrip",
    "-e",
    "POSTGRES_PASSWORD=fixture-only",
    "-e",
    "POSTGRES_DB=cantrip",
    "-e",
    "PGDATA=/var/lib/cantrip-test-postgres",
    "--mount",
    `type=volume,source=${pgVolume},target=/var/lib/cantrip-test-postgres`,
    values["postgres-image"],
  );
  containers.push(pg);
  await retry(
    () =>
      docker(
        "exec",
        pg,
        "psql",
        "-U",
        "cantrip",
        "-d",
        "cantrip",
        "-c",
        "SELECT 1",
      ),
    pg,
  );
  for (const mode of ["pglite", "bundled-postgres", "postgres"]) {
    const name = prefix + "-" + mode,
      volume = name + "-data";
    await docker("volume", "create", volume);
    volumes.push(volume);
    const selected =
      mode === "postgres"
        ? [
            "-e",
            `DATABASE_URL=postgresql://cantrip:fixture-only@${pg}:5432/cantrip`,
          ]
        : ["-e", `CANTRIP_DATABASE_MODE=${mode}`];
    const runtimeArgs = [
      "--platform",
      platform,
      "--network",
      network,
      "--read-only",
      "--tmpfs",
      "/tmp:noexec,size=256m,mode=1777",
      "--mount",
      `type=volume,source=${volume},target=/var/lib/cantrip`,
      "-e",
      "CANTRIP_SERVER_HOST=0.0.0.0",
      "-e",
      "CANTRIP_BOOTSTRAP_MODE=standalone",
      "-e",
      "CANTRIP_AUTH_MODE=none",
      "-e",
      "CANTRIP_DEPLOYMENT_MODE=local",
      "-e",
      "CANTRIP_ALLOW_INSECURE_REMOTE=true",
      ...selected,
    ];
    await docker(
      "run",
      "--detach",
      "--name",
      name,
      "-p",
      "127.0.0.1::4310",
      ...runtimeArgs,
      runtimeImage,
    );
    containers.push(name);
    const origin = async () => {
      const address = await docker("port", name, "4310/tcp");
      const endpoint = address.split("\n")[0];
      assert.ok(endpoint, "Waiting for Docker to publish the HTTP port");
      return "http://" + endpoint;
    };
    let localBootstrap;
    const visit = async (mutate) => {
      const base = await retry(async () => {
        const endpoint = await origin();
        const response = await fetch(endpoint + "/readyz", {
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200);
        assert.equal(
          (await response.json()).database.engine,
          mode === "pglite" ? "pglite" : "postgres",
        );
        return endpoint;
      }, name);
      const cookies = new Map();
      let csrf;
      const request = async (route, options = {}) => {
        const response = await fetch(base + route, {
          ...options,
          headers: {
            origin: "http://127.0.0.1:5173",
            cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
            ...(csrf ? { "x-cantrip-csrf": csrf } : {}),
            ...(options.body ? { "content-type": "application/json" } : {}),
          },
        });
        for (const line of response.headers.getSetCookie()) {
          const pair = line.split(";")[0],
            at = pair.indexOf("=");
          cookies.set(pair.slice(0, at), pair.slice(at + 1));
        }
        const body = await response.json();
        assert.equal(response.status, 200, route + ": " + JSON.stringify(body));
        if (body.csrfToken) csrf = body.csrfToken;
        return body;
      };
      await request("/api/auth/session");
      if (mutate)
        await request("/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ theme: "dark" }),
        });
      assert.equal((await request("/api/settings")).preferences.theme, "dark");
      localBootstrap = (await request("/api/bootstrap")).server;
      return localBootstrap.id;
    };
    const identity = await visit(true);
    const runtimeIdentity = await containerRuntimeIdentity(
      docker,
      name,
      inspected.Architecture,
    );
    if (values.architecture)
      assert.equal(runtimeIdentity.architecture, values.architecture);
    assert.deepEqual(
      localBootstrap.version,
      Object.fromEntries(
        ["major", "minor", "patch", "version"].map((key) => [
          key,
          runtimeIdentity.artifactVersion[key],
        ]),
      ),
      "public version fields match the executed artifact",
    );
    assert.equal(await docker("exec", name, "id", "-u"), "10001");
    const mount = (await docker("exec", name, "cat", "/proc/mounts"))
      .split("\n")
      .map((line) => line.split(" "))
      .find((fields) => fields[1] === "/tmp");
    assert.ok(
      mount?.[3].split(",").includes("noexec"),
      "exercise the real noexec temporary mount",
    );
    assert.equal(
      await docker("exec", name, "uname", "-m"),
      inspected.Architecture === "amd64" ? "x86_64" : "aarch64",
    );
    await docker(
      "exec",
      name,
      "sh",
      "-c",
      "! command -v node && ! command -v npm && ! command -v cargo && test ! -e /opt/cantrip/dist/index.js",
    );
    await docker("stop", "--time", "30", name);
    const stopped = JSON.parse(await docker("inspect", name))[0];
    assert.equal(stopped.State.ExitCode, 0, "SIGTERM exits cleanly");
    // PGlite permits one owner. Run the separate release-migration process
    // after stopping the service, as the native deployment path does.
    await docker(
      "run",
      "--rm",
      ...runtimeArgs,
      "--entrypoint",
      "/opt/cantrip/migrate.sh",
      runtimeImage,
    );
    const exported = await docker(
      "run",
      "--rm",
      ...runtimeArgs,
      runtimeImage,
      "/opt/cantrip/migrate.sh",
      "--export-sql",
      "/var/lib/cantrip/package-export.sql",
    );
    const receipt = exported
      .split("\n")
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      })
      .find((event) => event.event === "database.export.completed");
    assert.ok(
      receipt,
      "the bundled native tools must complete an actual SQL export",
    );
    await docker("start", name);
    assert.equal(await visit(false), identity);
    const dumpFile = "/var/lib/cantrip/package-export.sql";
    assert.equal(
      Number(
        (await docker("exec", name, "wc", "-c", dumpFile)).split(/\s+/)[0],
      ),
      receipt.receipt.bytes,
    );
    assert.equal(
      (await docker("exec", name, "sha256sum", dumpFile)).split(/\s+/)[0],
      receipt.receipt.sha256,
    );
    const state = JSON.parse(await docker("inspect", name))[0];
    assert.equal(state.Config.User, "cantrip");
    assert.equal(state.HostConfig.ReadonlyRootfs, true);
    const output = await logs(name);
    if (values.report)
      await writeFile(
        path.join(path.dirname(values.report), name + ".log"),
        output + "\n",
      );
    report.modes.push({
      mode,
      identity,
      runtimeIdentity,
      nodeAbsent: true,
      nonRoot: true,
      readOnlyRoot: true,
      tmpfsMiB: 256,
      tmpfsNoexec: true,
      settingsWriteAndRestart: true,
      migrateLauncher: true,
      sqlExport: receipt,
      sigtermExitCode: stopped.State.ExitCode,
    });
    await docker("stop", "--time", "30", name);
    const hostedName = name + "-hosted";
    const hostedOverrides = {
      CANTRIP_BOOTSTRAP_MODE: "hosted",
      CANTRIP_DEPLOYMENT_MODE: "hosted",
      CANTRIP_AUTH_MODE: "accounts",
      CANTRIP_ALLOW_INSECURE_REMOTE: "false",
    };
    const hostedArgs = runtimeArgs.map((argument) => {
      const at = argument.indexOf("=");
      const key = argument.slice(0, at);
      return Object.hasOwn(hostedOverrides, key)
        ? `${key}=${hostedOverrides[key]}`
        : argument;
    });
    await docker(
      "run",
      "--detach",
      "--name",
      hostedName,
      ...hostedArgs,
      "-e",
      "CANTRIP_ADMIN_EMAIL=native-container@example.invalid",
      "-e",
      "CANTRIP_APP_ORIGINS=https://app.example.invalid",
      "-e",
      "CANTRIP_PUBLIC_ORIGIN=https://api.example.invalid",
      "-e",
      "CANTRIP_TRUSTED_PROXIES=loopback",
      "-e",
      `CANTRIP_SECRET_ENCRYPTION_KEYS=${JSON.stringify({ fixture: randomBytes(32).toString("base64") })}`,
      runtimeImage,
    );
    containers.push(hostedName);
    const curl = async (route) =>
      JSON.parse(
        await docker(
          "exec",
          hostedName,
          "curl",
          "--fail",
          "--silent",
          "--show-error",
          "-H",
          "x-forwarded-proto: https",
          "-H",
          "x-forwarded-host: api.example.invalid",
          "http://127.0.0.1:4310" + route,
        ),
      );
    await retry(async () => {
      const ready = await curl("/readyz");
      assert.equal(
        ready.database.engine,
        mode === "pglite" ? "pglite" : "postgres",
      );
    }, hostedName);
    const bootstrap = await curl("/api/bootstrap");
    assert.equal(bootstrap.server.id, identity);
    assert.equal(bootstrap.server.deploymentMode, "hosted");
    assert.equal(bootstrap.server.bootstrapMode, "hosted");
    await docker("stop", "--time", "30", hostedName);
    assert.equal(
      JSON.parse(await docker("inspect", hostedName))[0].State.ExitCode,
      0,
    );
    await docker("start", name);
    assert.equal(
      await visit(false),
      identity,
      "local writes remain intact after hosted use",
    );
    await docker("stop", "--time", "30", name);
    report.modes.at(-1).hostedReopen = true;
    report.modes.at(-1).localReopenAfterHosted = true;
  }
} catch (error) {
  failure = error;
  report.failure = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  for (const name of containers) {
    try {
      const output = await logs(name);
      if (values.report)
        await writeFile(
          path.join(path.dirname(values.report), name + ".failure.log"),
          output + "\n",
        );
    } catch {}
  }
} finally {
  for (const name of containers.reverse())
    await docker("rm", "--force", "--volumes", name);
  if (networkCreated) await docker("network", "rm", network);
  // Keep this run's data volumes as restart/write evidence until the milestone
  // has been archived; remove only these explicitly recorded owned volumes.
  report.retainedEvidenceVolumes = volumes;
  if (values.report) {
    await mkdir(path.dirname(values.report), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
}
if (failure) throw failure;
console.log(JSON.stringify(report));
