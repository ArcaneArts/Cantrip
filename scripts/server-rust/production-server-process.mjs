import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fixtureEnvironment } from "./process.mjs";
import { ownedWindowsWorkerProcesses } from "./windows-worker-tree.mjs";
const execute = promisify(execFile);

async function sha256(pathname) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(pathname)) hash.update(chunk);
  return hash.digest("hex");
}

async function windowsWorkingSet(pid) {
  const script = `
$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance Win32_Process | ForEach-Object {
  [PSCustomObject]@{
    id = [int]$_.ProcessId
    parent = [int]$_.ParentProcessId
    created = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks.ToString() } else { '' }
    rssKiB = [double]$_.WorkingSetSize / 1024
  }
})
ConvertTo-Json -InputObject $processes -Compress
`;
  const { stdout } = await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { timeout: 30000, windowsHide: true },
  );
  return ownedWindowsWorkerProcesses(JSON.parse(stdout), pid).map(
    ({ id, parent, rssKiB }) => ({ pid: id, ppid: parent, rssKiB }),
  );
}

export async function productionProcess({
  runtime,
  artifact,
  nodeDirectory,
  profile,
  database = "pglite",
  databaseUrl,
  port = 0,
  logs,
}) {
  await mkdir(logs, { recursive: true });
  if (!port) {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    port = listener.address().port;
    await new Promise((resolve, reject) =>
      listener.close((e) => (e ? reject(e) : resolve())),
    );
  }
  const env = {
    ...fixtureEnvironment(profile),
    NODE_ENV: "production",
    CANTRIP_BOOTSTRAP_MODE: "standalone",
    CANTRIP_SERVER_PORT: String(port),
    CANTRIP_APP_ORIGINS: "http://127.0.0.1:5173",
    CANTRIP_LICENSE_WHITELIST_ENABLED: "false",
  };
  delete env.CANTRIP_WORKER_TOKEN;
  delete env.PGLITE_RUNTIME_DIR;
  if (databaseUrl) env.DATABASE_URL = databaseUrl;
  const windows = process.platform === "win32";
  const command =
    runtime === "node"
      ? process.execPath
      : path.join(artifact, windows ? "bin/cantrip-server.exe" : "start.sh");
  const entry =
    runtime === "node"
      ? path.join(nodeDirectory, "dist/index.js")
      : path.join(
          artifact,
          windows ? "bin/cantrip-server.exe" : "bin/cantrip-server",
        );
  const executableSha256 = await sha256(
    runtime === "node" ? process.execPath : entry,
  );
  const identity = {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    executableSha256,
    entrySha256: runtime === "node" ? await sha256(entry) : executableSha256,
  };
  const args =
    runtime === "node"
      ? [
          ...(windows
            ? [
                "--import",
                new URL("./legacy-node-shutdown.mjs", import.meta.url).href,
              ]
            : []),
          entry,
        ]
      : [
          ...(windows
            ? [
                "--shutdown-on-stdin-close",
                "--env-file-if-exists=.env",
                "--bundled-pglite-runtime-dir=" + path.join(artifact, "pglite"),
                "--bundled-postgres-bin-dir=" +
                  path.join(artifact, "postgres/bin"),
              ]
            : []),
          "--port",
          String(port),
          "--database",
          database,
        ];
  const startedAt = performance.now();
  const child = spawn(command, args, {
    cwd: runtime === "node" ? nodeDirectory : artifact,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "",
    spawnError;
  child.once("error", (e) => {
    spawnError = e;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (b) => {
      output = (output + b.toString()).slice(-4 * 1024 * 1024);
    });
  const completion = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const origin = `http://127.0.0.1:${port}`;
  const instance = {
    child,
    origin,
    port,
    logs,
    identity,
    startupMs: null,
    diagnostics: () => output,
    async stop(signal = "SIGTERM") {
      const t = performance.now();
      if (child.exitCode === null && child.signalCode === null) {
        if (windows && signal === "SIGTERM") child.stdin.end();
        else child.kill(signal);
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
      try {
        const exit = await completion;
        await writeFile(path.join(logs, "process.log"), output);
        if (signal === "SIGTERM")
          assert.equal(
            exit.code,
            0,
            "Production server graceful shutdown: " +
              JSON.stringify(exit) +
              "\n" +
              output.slice(-8000),
          );
        return { ...exit, durationMs: performance.now() - t };
      } finally {
        clearTimeout(timer);
      }
    },
    async rss() {
      if (windows) {
        const processes = await windowsWorkingSet(child.pid);
        return {
          totalKiB: processes.reduce((total, row) => total + row.rssKiB, 0),
          processes,
        };
      }
      const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,rss="]);
      const rows = stdout
          .trim()
          .split("\n")
          .map((l) => l.trim().split(/\s+/).map(Number)),
        owned = new Set([child.pid]);
      for (;;) {
        const n = owned.size;
        for (const [pid, ppid] of rows) if (owned.has(ppid)) owned.add(pid);
        if (n === owned.size) break;
      }
      const processes = rows
        .filter(([pid]) => owned.has(pid))
        .map(([pid, ppid, rssKiB]) => ({ pid, ppid, rssKiB }));
      return {
        totalKiB: processes.reduce((n, p) => n + p.rssKiB, 0),
        processes,
      };
    },
  };
  try {
    for (;;) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          "Production server exited during readiness: " + output.slice(-8000),
        );
      try {
        const r = await fetch(origin + "/readyz", {
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(r.status, 200);
        await r.json();
        break;
      } catch (e) {
        if (performance.now() - startedAt > 60000) throw e;
      }
      await delay(10);
    }
    instance.startupMs = performance.now() - startedAt;
    return instance;
  } catch (e) {
    await instance.stop("SIGKILL");
    throw e;
  }
}

export function productionClient(server) {
  const cookies = new Map();
  let csrf;
  return {
    server,
    client: () => ({ cookies }),
    async visit(_label, method, route, options = {}) {
      const r = await fetch(server.origin + route, {
        method,
        headers: {
          origin: "http://127.0.0.1:5173",
          cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          ...(csrf ? { "x-cantrip-csrf": csrf } : {}),
          ...(options.json ? { "content-type": "application/json" } : {}),
        },
        ...(options.json ? { body: JSON.stringify(options.json) } : {}),
        signal: AbortSignal.timeout(15000),
      });
      const body = r.status === 204 ? null : await r.json();
      assert.equal(
        r.status,
        options.status ?? 200,
        route + " HTTP " + r.status,
      );
      for (const line of r.headers.getSetCookie()) {
        const pair = line.split(";")[0],
          at = pair.indexOf("=");
        cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
      if (body?.csrfToken) csrf = body.csrfToken;
      return body;
    },
  };
}
