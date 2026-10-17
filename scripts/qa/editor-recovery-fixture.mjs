import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  collectProcessTreePids,
  parseUnixProcessTable,
  forceKillProcessTree,
} from "../devtop-processes.mjs";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
async function ownedProcessTree(pid) {
  if (process.platform === "win32") {
    const { stdout } = await exec("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
    ]);
    return collectProcessTreePids(
      pid,
      JSON.parse(stdout).map((entry) => ({
        pid: entry.ProcessId,
        ppid: entry.ParentProcessId,
      })),
    );
  }
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,command="]);
  return collectProcessTreePids(pid, parseUnixProcessTable(stdout));
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const appRequire = createRequire(path.join(root, "cantrip_app/package.json"));
const workerRequire = createRequire(
  path.join(root, "cantrip_worker/package.json"),
);
const { WebSocket, WebSocketServer } = workerRequire("ws");

async function availablePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

/** Runs production entrypoints with state and browser origins owned by this run. */
export async function startEditorRecoveryFixture() {
  const runId = randomUUID();
  const directory = path.join(root, ".qa", `editor-${runId}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const events = [];
  const eventCounts = Object.create(null);
  const sockets = new Set();
  const networkSockets = new Set();
  const trackSockets = (server) =>
    server.on("connection", (socket) => {
      networkSockets.add(socket);
      socket.once("close", () => networkSockets.delete(socket));
    });
  const children = new Map();
  const logStreams = [];
  const faults = {
    failRenewals: 0,
    rejectSessionCreates: false,
    renewalStatus: 503,
    rejectUpgrades: false,
    dropPong: false,
  };
  const serverPort = await availablePort();
  const controlToken = randomUUID();
  let closing = false;
  const event = (type, data = {}) => {
    eventCounts[type] = (eventCounts[type] ?? 0) + 1;
    const entry = { timestamp: new Date().toISOString(), ...data, type };
    events.push(entry);
    console.log(`QA_EVT ${JSON.stringify(entry)}`);
  };

  let proxy;
  let vite;
  let control;
  let fixture;
  try {
    proxy = http.createServer((request, response) => {
      if (
        faults.rejectSessionCreates &&
        request.method === "POST" &&
        /\/worker-link\/sessions(?:\?|$)/u.test(request.url)
      ) {
        event("fault.session-create", { path: request.url });
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: "Injected QA session creation failure" }),
        );
        return;
      }
      if (faults.failRenewals > 0 && /\/renew(?:\?|$)/u.test(request.url)) {
        faults.failRenewals -= 1;
        event("fault.renewal", {
          status: faults.renewalStatus,
          path: request.url,
        });
        response.writeHead(faults.renewalStatus, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ error: "Injected QA renewal failure" }));
        return;
      }
      const upstream = http.request(
        {
          hostname: "127.0.0.1",
          port: serverPort,
          method: request.method,
          path: request.url,
          headers: { ...request.headers, host: new URL(origin).host },
        },
        (incoming) => {
          response.writeHead(incoming.statusCode, incoming.headers);
          incoming.pipe(response);
        },
      );
      upstream.on("error", (error) => {
        if (!response.headersSent)
          response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error.message }));
      });
      response.on("close", () => upstream.destroy());
      request.pipe(upstream);
    });
    const websocketServer = new WebSocketServer({
      noServer: true,
      autoPong: false,
      handleProtocols: (_protocols, request) => request.qaProtocol || false,
    });
    websocketServer.on("headers", (headers, request) => {
      for (const [name, value] of Object.entries(
        request.qaUpstreamHeaders ?? {},
      )) {
        if (name.startsWith("x-cantrip-") && typeof value === "string")
          headers.push(`${name}: ${value}`);
      }
    });
    proxy.on("upgrade", (request, socket, head) => {
      if (faults.rejectUpgrades) return socket.destroy();
      const headers = { ...request.headers };
      for (const name of [
        "host",
        "connection",
        "upgrade",
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-extensions",
        "sec-websocket-protocol",
      ])
        delete headers[name];
      const protocols =
        request.headers["sec-websocket-protocol"]?.split(/,\s*/u) ?? [];
      headers.host = new URL(origin).host;
      const upstream = new WebSocket(
        `ws://127.0.0.1:${serverPort}${request.url}`,
        protocols,
        { headers, autoPong: false },
      );
      socket.once("close", () => upstream.terminate());
      upstream.once("upgrade", (response) => {
        request.qaUpstreamHeaders = response.headers;
      });
      upstream.once("error", () => socket.destroy());
      upstream.once("open", () => {
        if (socket.destroyed) return upstream.terminate();
        request.qaProtocol = upstream.protocol;
        websocketServer.handleUpgrade(request, socket, head, (downstream) => {
          const connection = { downstream, upstream, path: request.url };
          sockets.add(connection);
          downstream.on("message", (data, binary) => {
            if (upstream.readyState === WebSocket.OPEN)
              upstream.send(data, { binary });
          });
          event("socket.open", { path: request.url });
          upstream.on("message", (data, binary) => {
            if (downstream.readyState === WebSocket.OPEN)
              downstream.send(data, { binary });
          });
          upstream.on("ping", (data) => {
            if (downstream.readyState === WebSocket.OPEN) downstream.ping(data);
          });
          downstream.on("pong", (data) => {
            if (!faults.dropPong && upstream.readyState === WebSocket.OPEN)
              upstream.pong(data);
            else event("fault.pong-dropped", { path: request.url });
          });
          downstream.on("ping", (data) => {
            if (upstream.readyState === WebSocket.OPEN) upstream.ping(data);
          });
          upstream.on("pong", (data) => {
            if (faults.dropPong)
              event("fault.pong-dropped", { path: request.url });
            else if (downstream.readyState === WebSocket.OPEN)
              downstream.pong(data);
          });
          const retire = () => {
            sockets.delete(connection);
            upstream.terminate();
            downstream.terminate();
          };
          downstream.once("close", retire);
          upstream.once("close", retire);
          downstream.once("error", retire);
          upstream.once("error", retire);
        });
      });
    });
    trackSockets(proxy);
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`;
    const { build, preview } = await import(appRequire.resolve("vite"));
    // This affects only this fixture process, never a persisted development profile.
    process.env.VITE_CANTRIP_LOCAL_ONLY = "true";
    const hostname = `qa-${runId}.localhost`;
    const appDirectory = path.join(directory, "app");
    await build({
      root: path.join(root, "cantrip_app"),
      cacheDir: path.join(directory, "vite-cache"),
      configFile: path.join(root, "cantrip_app/vite.config.ts"),
      build: { outDir: appDirectory, emptyOutDir: true },
      logLevel: "warn",
    });
    vite = await preview({
      root: path.join(root, "cantrip_app"),
      configFile: false,
      build: { outDir: appDirectory },
      preview: {
        host: "127.0.0.1",
        port: await availablePort(),
        strictPort: true,
        allowedHosts: [hostname],
        proxy: {
          "/api": { target: proxyOrigin, changeOrigin: true, ws: true },
        },
      },
    });
    const origin = `http://${hostname}:${vite.httpServer.address().port}`;
    trackSockets(vite.httpServer);
    const childEnvironment = {
      ...process.env,
      CANTRIP_SERVER_HOST: "127.0.0.1",
      CANTRIP_SERVER_PORT: String(serverPort),
      CANTRIP_PUBLIC_ORIGIN: origin,
      CANTRIP_APP_ORIGINS: origin,
      CANTRIP_AUTH_MODE: "none",
      CANTRIP_DEPLOYMENT_MODE: "local",
      CANTRIP_BOOTSTRAP_MODE: "pnpm-dev",
      CANTRIP_DATA_DIR: path.join(directory, "server"),
      CANTRIP_WORKER_DATA_DIR: path.join(directory, "worker"),
      CANTRIP_SERVER_URL: proxyOrigin,
      CANTRIP_WORKER_DEVELOPMENT_BOOTSTRAP: "true",
      CANTRIP_WORKER_ID: `qa-${runId}`,
      CANTRIP_WORKER_NAME: `QA ${runId}`,
      CODEX_HOME: path.join(directory, "codex-home"),
    };
    // Do not let inherited production deployment/enrollment configuration escape isolation.
    for (const name of [
      "DATABASE_URL",
      "REDIS_URL",
      "CANTRIP_WORKER_CREDENTIAL",
      "CANTRIP_WORKER_ENROLLMENT_CODE",
      "CANTRIP_WORKER_REPLACES_ID",
      "CANTRIP_WORKER_REPLACES_CREDENTIAL",
      "CANTRIP_WORKER_TOKEN",
      "CANTRIP_SERVER_INSTANCE_ID",
    ])
      delete childEnvironment[name];
    const launch = (name) => {
      const stream = createWriteStream(path.join(directory, `${name}.log`), {
        flags: "a",
      });
      logStreams.push(stream);
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          name === "server"
            ? path.join(root, "scripts/qa/editor-recovery-server.mts")
            : "src/index.ts",
        ],
        {
          cwd: path.join(root, `cantrip_${name}`),
          env: childEnvironment,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.set(name, child);
      child.stdout.pipe(stream, { end: false });
      child.stderr.pipe(stream, { end: false });
      child.once("error", (error) =>
        event("process.error", { name, message: error.message }),
      );
      child.once("exit", (code, signal) =>
        event("process.exit", { name, code, signal }),
      );
      event("process.start", { name, pid: child.pid });
      return child;
    };
    const stop = async (name) => {
      const child = children.get(name);
      if (!child || child.exitCode !== null || child.signalCode !== null)
        return;
      const started = performance.now();
      const exit = new Promise((resolve) => child.once("exit", resolve));
      let ownedPids = [child.pid];
      let snapshotError;
      try {
        ownedPids = await ownedProcessTree(child.pid);
      } catch (error) {
        snapshotError = error.message;
      }
      child.kill("SIGTERM");
      const stopWait = new AbortController();
      try {
        await Promise.race([
          exit,
          delay(8_000, undefined, { signal: stopWait.signal }),
        ]);
      } finally {
        stopWait.abort();
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exit;
      }
      let survivors = ownedPids.filter(processAlive);
      const descendantDeadline = Date.now() + 2_000;
      while (survivors.length && Date.now() < descendantDeadline) {
        await delay(50);
        survivors = survivors.filter(processAlive);
      }
      event("process.stopped", {
        name,
        pid: child.pid,
        code: child.exitCode,
        signal: child.signalCode,
        durationMs: Math.round(performance.now() - started),
        ownedPids,
        survivors,
        snapshotError,
      });
      // Failed retirement remains in the evidence; cleanup touches only this tree.
      for (const pid of survivors) forceKillProcessTree(pid);
    };
    const waitForServer = async () => {
      const deadline = Date.now() + 90_000;
      let lastError;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`${proxyOrigin}/api/bootstrap`, {
            signal: AbortSignal.timeout(2_000),
          });
          if (response.ok) return await response.json();
          lastError = new Error(`Bootstrap returned ${response.status}`);
        } catch (error) {
          lastError = error;
        }
        const child = children.get("server");
        if (child?.exitCode !== null)
          throw new Error(
            `Server exited: ${await readFile(path.join(directory, "server.log"), "utf8")}`,
          );
        await delay(200);
      }
      throw new Error(`Server failed to become ready: ${lastError}`);
    };
    control = http.createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${controlToken}`) {
        response.writeHead(403);
        response.end();
        return;
      }
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        const result = await fixture.inject(input);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(500);
        response.end(JSON.stringify({ error: error.message }));
      }
    });
    fixture = {
      directory,
      origin,
      proxyOrigin,
      events,
      workerId: childEnvironment.CANTRIP_WORKER_ID,
      async inject(input) {
        event("fault.requested", input);
        if (input.type === "restart") {
          if (!["server", "worker"].includes(input.process))
            throw new Error(
              "Only fixture-owned server and worker processes can restart.",
            );
          await stop(input.process);
          launch(input.process);
          if (input.process === "server") await waitForServer();
        } else if (input.type === "carrier") {
          for (const connection of sockets)
            if (!input.path || connection.path.includes(input.path))
              connection.downstream.terminate();
        } else if (input.type === "faults") Object.assign(faults, input.values);
        else if (input.type !== "stats")
          throw new Error(`Unknown fixture operation ${input.type}`);
        return {
          sockets: sockets.size,
          children: Object.fromEntries(
            [...children].map(([name, child]) => [
              name,
              { pid: child.pid, exitCode: child.exitCode },
            ]),
          ),
          faults: { ...faults },
          eventCounts: { ...eventCounts },
        };
      },
      async close() {
        if (closing) return;
        closing = true;
        await stop("worker");
        await stop("server");
        for (const connection of sockets) {
          connection.downstream.terminate();
          connection.upstream.terminate();
        }
        for (const socket of networkSockets) socket.destroy();
        await vite.close();
        await Promise.all([
          new Promise((resolve) => proxy.close(resolve)),
          new Promise((resolve) => control.close(resolve)),
        ]);
        for (const stream of logStreams) stream.end();
        event("fixture.closed", { sockets: sockets.size });
        await writeFile(
          path.join(directory, "events.json"),
          JSON.stringify(events, null, 2),
        );
      },
    };
    try {
      trackSockets(control);
      launch("server");
      await waitForServer();
      launch("worker");
      await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
      const metadata = {
        runId,
        origin,
        directory,
        workerId: fixture.workerId,
        controlOrigin: `http://127.0.0.1:${control.address().port}`,
        controlToken,
      };
      await writeFile(
        path.join(directory, "fixture.json"),
        JSON.stringify(metadata, null, 2),
        { mode: 0o600 },
      );
      event("fixture.ready", { origin, directory, workerId: fixture.workerId });
      return fixture;
    } catch (error) {
      await fixture.close();
      throw error;
    }
  } catch (error) {
    if (fixture) await fixture.close();
    else {
      for (const socket of networkSockets) socket.destroy();
      await vite?.close();
      await Promise.all(
        [proxy, control]
          .filter(Boolean)
          .map((server) => new Promise((resolve) => server.close(resolve))),
      );
      for (const stream of logStreams) stream.end();
    }
    throw error;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const fixture = await startEditorRecoveryFixture();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => void fixture.close().then(() => process.exit()));
}
