import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { containerRuntimeIdentity } from "./container-runtime-identity.mjs";

const execute = promisify(execFile);
async function docker(...args) {
  return (
    await execute("docker", args, { maxBuffer: 16 * 1024 * 1024 })
  ).stdout.trim();
}

async function inspect(name) {
  return JSON.parse(await docker("inspect", name))[0];
}

async function untilReady(name, check) {
  const deadline = performance.now() + 60_000;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      const { State } = await inspect(name);
      if (!State.Running || performance.now() >= deadline)
        throw new Error(`${name} did not become ready: ${State.Status}`, {
          cause: error,
        });
      await delay(100);
    }
  }
}

// An owned Docker network, server data volume, and (when required) database
// persist across the two server generations. Only the HTTP port is published.
export async function productionStreamContainer({
  image,
  runtime,
  database,
  postgresImage,
}) {
  const candidate = JSON.parse(await docker("image", "inspect", image))[0];
  assert.equal(candidate.Os, "linux");
  const prefix = "cantrip-log-stream-" + randomUUID().slice(0, 12);
  const network = prefix + "-net";
  const volume = prefix + "-server-data";
  const databaseName = prefix + "-db";
  const databaseVolume = prefix + "-db-data";
  const needsExternal =
    database === "postgres" ||
    (runtime === "node" && database === "bundled-postgres");
  const cleanup = [];
  let databaseUrl,
    databaseIdentity,
    generation = 0;

  async function close() {
    const errors = [];
    for (const action of cleanup.splice(0).reverse()) {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Container fixture cleanup failed");
  }

  try {
    await docker("network", "create", network);
    cleanup.push(() => docker("network", "rm", network));
    await docker("volume", "create", volume);
    cleanup.push(() => docker("volume", "rm", volume));
    if (needsExternal) {
      const pg = JSON.parse(await docker("image", "inspect", postgresImage))[0];
      await docker("volume", "create", databaseVolume);
      cleanup.push(() => docker("volume", "rm", databaseVolume));
      const password = randomBytes(18).toString("hex");
      await docker(
        "run",
        "--detach",
        "--name",
        databaseName,
        "--network",
        network,
        "--mount",
        `type=volume,source=${databaseVolume},target=/var/lib/cantrip-test-postgres`,
        "-e",
        "PGDATA=/var/lib/cantrip-test-postgres",
        "-e",
        "POSTGRES_USER=cantrip",
        "-e",
        "POSTGRES_DB=cantrip",
        "-e",
        "POSTGRES_PASSWORD=" + password,
        pg.Id,
      );
      cleanup.push(() => docker("rm", "-fv", databaseName));
      await untilReady(databaseName, () =>
        docker(
          "exec",
          databaseName,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "cantrip",
          "-d",
          "cantrip",
        ),
      );
      databaseUrl = `postgresql://cantrip:${password}@${databaseName}:5432/cantrip`;
      databaseIdentity = {
        imageId: pg.Id,
        architecture: pg.Architecture,
        version: await docker("exec", databaseName, "postgres", "--version"),
      };
    }
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Container fixture setup failed",
      );
    }
    throw error;
  }

  return {
    close,
    databaseIdentity,
    imageId: candidate.Id,
    architecture: candidate.Architecture,
    async start({ port, logs }) {
      await mkdir(logs, { recursive: true });
      const name = prefix + "-" + ++generation;
      const args =
        runtime === "rust"
          ? ["/opt/cantrip/start.sh", "--database", database]
          : [];
      const publish = `127.0.0.1:${port ?? ""}:4310`;
      const startedAt = performance.now();
      await docker(
        "run",
        "--detach",
        "--name",
        name,
        "--platform",
        `linux/${candidate.Architecture}`,
        "--network",
        network,
        "--read-only",
        "--tmpfs",
        "/tmp:noexec,size=256m,mode=1777",
        "--mount",
        `type=volume,source=${volume},target=/var/lib/cantrip`,
        "--publish",
        publish,
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
        "-e",
        "CANTRIP_APP_ORIGINS=http://127.0.0.1:5173",
        "-e",
        "CANTRIP_LICENSE_WHITELIST_ENABLED=false",
        ...(databaseUrl ? ["-e", "DATABASE_URL=" + databaseUrl] : []),
        candidate.Id,
        ...args,
      );
      const remove = () => docker("rm", "-fv", name);
      cleanup.push(remove);
      async function stop(signal = "SIGTERM") {
        const stoppedAt = performance.now();
        const state = (await inspect(name)).State;
        if (state.Running) {
          if (signal === "SIGTERM") await docker("stop", "--time", "25", name);
          else await docker("kill", "--signal", signal, name);
        }
        const exit = Number(await docker("wait", name));
        const result = await execute("docker", ["logs", name], {
          maxBuffer: 16 * 1024 * 1024,
        });
        const output = result.stdout + result.stderr;
        await writeFile(path.join(logs, "process.log"), output);
        await remove();
        cleanup.splice(cleanup.indexOf(remove), 1);
        assert.equal(exit, signal === "SIGTERM" ? 0 : 137, output.slice(-8000));
        return {
          code: signal === "SIGTERM" ? exit : null,
          signal: signal === "SIGTERM" ? null : signal,
          containerExitCode: exit,
          durationMs: performance.now() - stoppedAt,
        };
      }
      const address = (await docker("port", name, "4310/tcp")).split("\n")[0];
      assert.match(address, /^127\.0\.0\.1:\d+$/);
      const origin = "http://" + address;
      const ready = await untilReady(name, async () => {
        const response = await fetch(origin + "/readyz", {
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200);
        return response.json();
      });
      const startupMs = performance.now() - startedAt;
      assert.equal(
        ready.database.engine,
        database === "pglite" ? "pglite" : "postgres",
      );
      const identity =
        runtime === "rust"
          ? await containerRuntimeIdentity(docker, name, candidate.Architecture)
          : {
              executableSha256: (
                await docker(
                  "exec",
                  name,
                  "sha256sum",
                  "/opt/cantrip/runtime/node",
                )
              ).split(/\s+/)[0],
              entrySha256: (
                await docker(
                  "exec",
                  name,
                  "sha256sum",
                  "/opt/cantrip/dist/index.js",
                )
              ).split(/\s+/)[0],
              nodeVersion: await docker(
                "exec",
                name,
                "/opt/cantrip/runtime/node",
                "--version",
              ),
            };
      return {
        origin,
        port: Number(new URL(origin).port),
        startupMs,
        identity,
        stop,
        async rss() {
          const lines = await docker(
            "exec",
            name,
            "sh",
            "-c",
            "for p in /proc/[0-9]*; do awk '/^Pid:/ {id=$2} /^PPid:/ {parent=$2} /^VmRSS:/ {rss=$2} END {if (id && rss) print id, parent, rss}' \"$p/status\" 2>/dev/null; done; true",
          );
          const rows = lines
            .split("\n")
            .filter(Boolean)
            .map((line) => line.split(/\s+/).map(Number));
          const owned = new Set([1]);
          for (;;) {
            const size = owned.size;
            for (const [pid, parent] of rows)
              if (owned.has(parent)) owned.add(pid);
            if (owned.size === size) break;
          }
          const processes = rows
            .filter(([pid]) => owned.has(pid))
            .map(([pid, ppid, rssKiB]) => ({ pid, ppid, rssKiB }));
          assert.ok(
            processes.length >= 2,
            "Expected tini and a server process",
          );
          return {
            totalKiB: processes.reduce((total, row) => total + row.rssKiB, 0),
            processes,
          };
        },
      };
    },
  };
}
