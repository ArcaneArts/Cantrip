import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import {
  createServer as createTcpServer,
  type Server as NetServer,
} from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { verifyCantripCodeInstallation } from "../src/code/installation.js";
import { CodeWorkbenchBridge } from "../src/code/workbench-bridge.js";
import {
  CodeSupervisor,
  terminateCodeProcess,
  type CodeSupervisorOptions,
  waitForAuthenticatedCodeHttp,
} from "../src/code/supervisor.js";

const directories: string[] = [];
const supervisors: CodeSupervisor[] = [];
const healthServers: NetServer[] = [];

afterEach(async () => {
  await Promise.all(
    supervisors.splice(0).map((supervisor) => supervisor.close()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  await Promise.all(
    healthServers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function listenHealthServer(server: NetServer): Promise<number> {
  healthServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not listen for the health test.");
  }
  return address.port;
}

type FixtureOptions = Pick<
  CodeSupervisorOptions,
  | "bridge"
  | "editorIdleTimeoutMs"
  | "idleSweepIntervalMs"
  | "idleTimeoutMs"
  | "profileIdleTimeoutMs"
  | "profileLogWriter"
  | "readinessTimeoutMs"
> & {
  failStartup?: boolean;
  gateStartup?: boolean;
  ignoreSigterm?: boolean;
  unhealthyStartup?: boolean;
};

function codeServerSource(
  options: {
    failStartup?: boolean;
    ignoreSigterm?: boolean;
    startupGate?: string | null;
    unhealthyStartup?: boolean;
  } = {},
): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const connectionToken = process.argv[process.argv.indexOf("--connection-token") + 1];
const userDataDir = process.argv[process.argv.indexOf("--user-data-dir") + 1];
const startupGate = ${JSON.stringify(options.startupGate ?? null)};
const failStartup = ${JSON.stringify(options.failStartup ?? false)};
const ignoreSigterm = ${JSON.stringify(options.ignoreSigterm ?? false)};
const unhealthyStartup = ${JSON.stringify(options.unhealthyStartup ?? false)};
fs.writeFileSync(path.join(userDataDir, "launch-args.json"), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(userDataDir, "process.pid"), String(process.pid));
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const authenticated = url.searchParams.get("tkn") === connectionToken;
  fs.appendFileSync(path.join(userDataDir, "health-requests.log"), String(authenticated) + "\\n");
  if (!authenticated) {
    response.writeHead(403).end("forbidden");
    return;
  }
  if (unhealthyStartup) {
    response.writeHead(503).end("unhealthy startup");
    return;
  }
  let unhealthyPid = "";
  try {
    unhealthyPid = fs.readFileSync(path.join(userDataDir, "unhealthy.pid"), "utf8").trim();
  } catch {}
  if (unhealthyPid === String(process.pid)) {
    response.writeHead(503).end("unhealthy");
    return;
  }
  response.writeHead(302, { location: "/stable" }).end();
});
let gateTimer = null;
const start = () => {
  if (failStartup) process.exit(1);
  server.listen(port, "127.0.0.1", () => console.log("ready"));
};
if (startupGate) {
  gateTimer = setInterval(() => {
    if (!fs.existsSync(startupGate)) return;
    clearInterval(gateTimer);
    gateTimer = null;
    start();
  }, 5);
} else {
  start();
}
const stop = () => {
  if (gateTimer) clearInterval(gateTimer);
  if (ignoreSigterm) return;
  if (!server.listening) process.exit(0);
  server.close(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
`;
}

async function fixture(options: FixtureOptions = {}) {
  const {
    failStartup = false,
    gateStartup = false,
    ignoreSigterm = false,
    unhealthyStartup = false,
    ...supervisorOptions
  } = options;
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-code-supervisor-"));
  directories.push(root);
  const bundle = path.join(root, "bundle");
  const repository = path.join(root, "repository");
  const dataDirectory = path.join(root, "worker-data");
  const startupGate = gateStartup
    ? path.join(root, "profile-start.gate")
    : null;
  await Promise.all([
    mkdir(path.join(bundle, "bin"), { recursive: true }),
    mkdir(path.join(bundle, "extensions", "cantrip-workbench"), {
      recursive: true,
    }),
    mkdir(repository),
  ]);
  const source = codeServerSource({
    failStartup,
    ignoreSigterm,
    startupGate,
    unhealthyStartup,
  });
  const entrypoint = path.join(bundle, "bin", "cantrip-code.cjs");
  await writeFile(entrypoint, source);
  await chmod(entrypoint, 0o755);
  const bytes = Buffer.from(source);
  const workbenchContents = `${JSON.stringify({ name: "cantrip-workbench", version: "0.1.0" })}\n`;
  const workbenchBytes = Buffer.from(workbenchContents);
  await writeFile(
    path.join(bundle, "extensions", "cantrip-workbench", "package.json"),
    workbenchContents,
  );
  await writeFile(
    path.join(bundle, "cantrip-code.manifest.json"),
    JSON.stringify({
      schemaVersion: 3,
      component: "cantrip-code",
      version: "1.109.5-cantrip.1",
      target: `${process.platform}-${process.arch}`,
      platform: process.platform,
      arch: process.arch,
      fingerprint: "a".repeat(64),
      openvscodeServerCommit: "b".repeat(40),
      vscodeCommit: "c".repeat(40),
      patchset: 1,
      cantripWorkbenchVersion: "0.1.0",
      entrypoint: "bin/cantrip-code.cjs",
      files: [
        {
          path: "bin/cantrip-code.cjs",
          type: "file",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          executable: true,
        },
        {
          path: "extensions/cantrip-workbench/package.json",
          type: "file",
          size: workbenchBytes.length,
          sha256: createHash("sha256").update(workbenchBytes).digest("hex"),
          executable: false,
        },
      ],
    }),
  );
  const installation = await verifyCantripCodeInstallation(bundle, {
    full: true,
  });
  const capabilities = {
    available: true as const,
    version: installation.editorBuild.version,
    upstreamRevision: installation.editorBuild.upstreamRevision,
    patchset: installation.editorBuild.patchset,
    transport: "web-proxy" as const,
    maxSessions: 4,
    reason: null,
  };
  const supervisor = new CodeSupervisor({
    capabilities,
    dataDirectory,
    installation,
    readinessTimeoutMs: supervisorOptions.readinessTimeoutMs ?? 3_000,
    ...supervisorOptions,
  });
  supervisors.push(supervisor);
  await supervisor.start();
  return {
    capabilities,
    dataDirectory,
    entrypoint,
    installation,
    repository,
    startupGate,
    supervisor,
  };
}

function openCommand(
  sessionId: string,
  repository: string,
  worktreeId: string,
) {
  return {
    type: "code.open" as const,
    sessionId,
    codeTabId: `tab-${sessionId}`,
    projectId: "project-one",
    worktreeId,
    cwd: repository,
    profileId: "default",
    themeMode: "follow-cantrip" as const,
    appearance: "dark" as const,
    presentation: "workbench" as const,
  };
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

interface BridgeRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

async function openControlledBridge(url: string) {
  const socket = new WebSocket(url);
  const opened = new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  let nextRequest: ((request: BridgeRequest) => void) | null = null;
  let initialThemeResolved: (() => void) | null = null;
  const initialTheme = new Promise<void>((resolve) => {
    initialThemeResolved = resolve;
  });
  let receivedInitialTheme = false;
  const respond = (request: BridgeRequest) => {
    socket.send(
      JSON.stringify({
        type: "response",
        id: request.id,
        ok: true,
        result:
          request.method === "openFile"
            ? { relativePath: request.params.path }
            : { applied: true },
      }),
    );
  };
  socket.on("message", (data) => {
    const request = JSON.parse(data.toString()) as BridgeRequest;
    if (!receivedInitialTheme) {
      receivedInitialTheme = true;
      respond(request);
      initialThemeResolved?.();
      return;
    }
    const resolve = nextRequest;
    nextRequest = null;
    if (resolve) resolve(request);
    else respond(request);
  });
  await Promise.all([opened, initialTheme]);
  return {
    nextRequest: () =>
      new Promise<BridgeRequest>((resolve) => {
        nextRequest = resolve;
      }),
    respond,
    socket,
  };
}

async function waitForFile(file: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      await readFile(file, "utf8")
        .then(() => true)
        .catch(() => false)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${file}.`);
}

async function waitForFileChange(
  file: string,
  previous: string,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readFile(file, "utf8").catch(() => previous);
    if (value !== previous) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${file} to change.`);
}

describe("Cantrip Code functional HTTP health", () => {
  it("waits for an observed exit after escalating to SIGKILL", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    });
    const signals: NodeJS.Signals[] = [];
    let observeKill: (() => void) | null = null;
    const killObserved = new Promise<void>((resolve) => {
      observeKill = resolve;
    });
    let settled = false;
    const termination = terminateCodeProcess(
      child,
      (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          observeKill?.();
        }
      },
      10,
      100,
    ).then(() => {
      settled = true;
    });

    await killObserved;
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settled).toBe(false);
    child.exitCode = 137;
    child.emit("exit", 137, "SIGKILL");
    await termination;
    expect(settled).toBe(true);
  });

  it("requires an authenticated usable HTTP response", async () => {
    const tokens: Array<string | null> = [];
    const server = createHttpServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const token = url.searchParams.get("tkn");
      tokens.push(token);
      if (token !== "expected-token") {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(302, { location: "/stable" }).end();
    });
    const port = await listenHealthServer(server);

    await expect(
      waitForAuthenticatedCodeHttp(
        { exitCode: null, signalCode: null },
        port,
        "expected-token",
        250,
      ),
    ).resolves.toBeUndefined();
    expect(tokens).toEqual(["expected-token"]);
    await expect(
      waitForAuthenticatedCodeHttp(
        { exitCode: null, signalCode: null },
        port,
        "wrong-token",
        25,
      ),
    ).rejects.toThrow("last status 403");
  });

  it("does not mistake an open TCP listener for functional readiness", async () => {
    const server = createTcpServer((socket) => {
      socket.on("data", () => undefined);
    });
    const port = await listenHealthServer(server);

    await expect(
      waitForAuthenticatedCodeHttp(
        { exitCode: null, signalCode: null },
        port,
        "expected-token",
        25,
      ),
    ).rejects.toThrow("did not return an authenticated HTTP response");
  });
});

describe("Cantrip Code supervisor", () => {
  it("does not block reopening on an unresponsive workbench surface", async () => {
    const bridge = new CodeWorkbenchBridge({ requestTimeoutMs: 1_000 });
    const { repository, supervisor } = await fixture({ bridge });
    const command = openCommand("stale-workbench", repository, "primary");
    await supervisor.open(command);
    const target = supervisor.proxyTarget(command.sessionId);
    const workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, string> };
    const stale = await openSocket(workspace.settings["cantrip.bridgeUrl"]!);

    await expect(
      Promise.race([
        supervisor.open(command),
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("Reopening waited on the stale bridge.")),
            250,
          ),
        ),
      ]),
    ).resolves.toMatchObject({ status: "running" });
    stale.close();
  });

  it("serializes concurrent opens for the same durable session", async () => {
    const { repository, supervisor } = await fixture();
    const command = openCommand("shared", repository, "primary");
    const [first, second, third] = await Promise.all([
      supervisor.open(command),
      supervisor.open(command),
      supervisor.open(command),
    ]);

    expect(second.processInstanceId).toBe(first.processInstanceId);
    expect(third.processInstanceId).toBe(first.processInstanceId);
    expect(supervisor.status("shared").status).toBe("running");
  });

  it("invalidates a delayed open when stop arrives before profile readiness", async () => {
    const { dataDirectory, repository, startupGate, supervisor } =
      await fixture({ gateStartup: true });
    const sessionId = "stopped-during-open";
    const profileDirectory = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
    );
    const opening = supervisor.open(
      openCommand(sessionId, repository, "primary"),
    );
    await waitForFile(path.join(profileDirectory, "launch-args.json"));

    const stopping = supervisor.stop(sessionId);
    await writeFile(startupGate!, "ready\n");

    await expect(opening).rejects.toThrow("superseded");
    await expect(stopping).resolves.toMatchObject({ status: "stopped" });
    expect(() => supervisor.status(sessionId)).toThrow("is not open");
    await expect(
      readdir(path.join(dataDirectory, "code", "workspaces"), {
        recursive: true,
      }).then((entries) =>
        entries.filter((entry) => entry.endsWith(".code-workspace")),
      ),
    ).resolves.toEqual([]);
    await expect(
      readdir(path.join(dataDirectory, "code", "sessions"), {
        recursive: true,
      }),
    ).resolves.toEqual([]);
    const state = await readFile(
      path.join(dataDirectory, "code", "state", "runtime.json"),
      "utf8",
    );
    expect(state).not.toContain(sessionId);
  });

  it("lets queued open activity supersede a stale idle eviction candidate", async () => {
    const { repository, supervisor } = await fixture({
      idleSweepIntervalMs: 60_000,
      idleTimeoutMs: 1_000,
    });
    const command = openCommand("idle-open-race", repository, "primary");
    await supervisor.open(command);
    const target = supervisor.proxyTarget(command.sessionId);
    const workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, string> };
    const bridge = await openControlledBridge(
      workspace.settings["cantrip.bridgeUrl"]!,
    );
    const blockedRequest = bridge.nextRequest();
    const blocker = supervisor.setPresentation(command.sessionId, "workbench");
    const request = await blockedRequest;
    expect(request.method).toBe("setPresentation");

    const reopening = supervisor.open(command);
    const eviction = supervisor.evictIdleSessions(Date.now() + 2_000);
    bridge.respond(request);

    await expect(blocker).resolves.toMatchObject({ status: "running" });
    await expect(reopening).resolves.toMatchObject({ status: "running" });
    await expect(eviction).resolves.toEqual([]);
    expect(supervisor.status(command.sessionId).status).toBe("running");
    bridge.socket.close();
  });

  it.each(["openFile", "setPresentation", "setTheme"] as const)(
    "invalidates an in-flight %s mutation when stop arrives",
    async (mutationKind) => {
      const { dataDirectory, repository, supervisor } = await fixture();
      const sessionId = `mutation-stop-${mutationKind}`;
      await writeFile(path.join(repository, "next.ts"), "export {};\n");
      await supervisor.open(openCommand(sessionId, repository, "primary"));
      const target = supervisor.proxyTarget(sessionId);
      const workspace = JSON.parse(
        await readFile(new URL(target.workspaceUri), "utf8"),
      ) as { settings: Record<string, string> };
      const bridge = await openControlledBridge(
        workspace.settings["cantrip.bridgeUrl"]!,
      );
      const blockedRequest = bridge.nextRequest();
      const mutation =
        mutationKind === "openFile"
          ? supervisor.openFile(sessionId, "next.ts")
          : mutationKind === "setPresentation"
            ? supervisor.setPresentation(sessionId, "editor")
            : supervisor.setTheme(sessionId, "follow-cantrip", "light");
      const request = await blockedRequest;
      expect(request.method).toBe(mutationKind);

      const stopping = supervisor.stop(sessionId);
      bridge.respond(request);

      await expect(mutation).rejects.toThrow("superseded");
      await expect(stopping).resolves.toMatchObject({ status: "stopped" });
      expect(() => supervisor.status(sessionId)).toThrow("is not open");
      await expect(
        readFile(new URL(target.workspaceUri), "utf8"),
      ).rejects.toThrow();
      const state = await readFile(
        path.join(dataDirectory, "code", "state", "runtime.json"),
        "utf8",
      );
      expect(state).not.toContain(sessionId);
      bridge.socket.close();
    },
  );

  it("rolls back every newly registered resource when profile startup fails", async () => {
    const bridge = new CodeWorkbenchBridge();
    const unregister = vi.spyOn(bridge, "unregister");
    const { dataDirectory, entrypoint, repository, supervisor } = await fixture(
      {
        bridge,
        failStartup: true,
        profileIdleTimeoutMs: 1_000,
        readinessTimeoutMs: 500,
      },
    );
    const sessionId = "failed-open-rollback";

    await expect(
      supervisor.open(openCommand(sessionId, repository, "primary")),
    ).rejects.toThrow("exited before");
    expect(unregister).toHaveBeenCalledWith(sessionId);
    expect(() => supervisor.status(sessionId)).toThrow("is not open");
    await expect(
      readdir(path.join(dataDirectory, "code", "workspaces"), {
        recursive: true,
      }).then((entries) =>
        entries.filter((entry) => entry.endsWith(".code-workspace")),
      ),
    ).resolves.toEqual([]);
    await expect(
      readdir(path.join(dataDirectory, "code", "sessions"), {
        recursive: true,
      }),
    ).resolves.toEqual([]);
    const stateFile = path.join(dataDirectory, "code", "state", "runtime.json");
    expect(await readFile(stateFile, "utf8")).not.toContain(sessionId);

    await writeFile(entrypoint, codeServerSource());
    const recovered = await supervisor.open(
      openCommand("rollback-recovered", repository, "secondary"),
    );
    await supervisor.stop("rollback-recovered");
    await supervisor.evictIdleSessions(Date.now() + 2_000);
    const afterEviction = await supervisor.open(
      openCommand("rollback-after-eviction", repository, "tertiary"),
    );
    expect(afterEviction.processInstanceId).not.toBe(
      recovered.processInstanceId,
    );
  });

  it("observes failed startup process exit before allowing a retry", async () => {
    const { dataDirectory, entrypoint, repository, supervisor } = await fixture(
      {
        ignoreSigterm: true,
        readinessTimeoutMs: 500,
        unhealthyStartup: true,
      },
    );
    const profileDirectory = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
    );
    const processFile = path.join(profileDirectory, "process.pid");
    const opening = supervisor.open(
      openCommand("unhealthy-startup", repository, "primary"),
    );
    const openingFailure = expect(opening).rejects.toThrow(
      "authenticated HTTP response",
    );
    await waitForFile(processFile, 2_000);
    const failedPid = Number(await readFile(processFile, "utf8"));

    await openingFailure;
    expect(() => process.kill(failedPid, 0)).toThrow();
    expect(() => supervisor.status("unhealthy-startup")).toThrow("is not open");

    await writeFile(entrypoint, codeServerSource());
    await expect(
      supervisor.open(
        openCommand("healthy-startup-retry", repository, "secondary"),
      ),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("does not report running when the process exits during the ready log", async () => {
    let enterReadyLog: (() => void) | null = null;
    const readyLogEntered = new Promise<void>((resolve) => {
      enterReadyLog = resolve;
    });
    let releaseReadyLog: (() => void) | null = null;
    const readyLogRelease = new Promise<void>((resolve) => {
      releaseReadyLog = resolve;
    });
    let observeExitLog: (() => void) | null = null;
    const exitLogObserved = new Promise<void>((resolve) => {
      observeExitLog = resolve;
    });
    const { dataDirectory, repository, supervisor } = await fixture({
      profileLogWriter: async (_logPath, entry) => {
        if (entry.includes(" ready on loopback port ")) {
          enterReadyLog?.();
          await readyLogRelease;
        }
        if (entry.includes("process exited")) observeExitLog?.();
      },
      readinessTimeoutMs: 1_000,
    });
    const sessionId = "exit-during-ready-log";
    const processFile = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
      "process.pid",
    );
    const opening = supervisor.open(
      openCommand(sessionId, repository, "primary"),
    );
    const openingFailure = expect(opening).rejects.toThrow(
      "exited while completing startup",
    );

    await readyLogEntered;
    process.kill(Number(await readFile(processFile, "utf8")), "SIGKILL");
    await exitLogObserved;
    releaseReadyLog?.();

    await openingFailure;
    expect(() => supervisor.status(sessionId)).toThrow("is not open");
  });

  it("serializes a fired crash restart with last-session stop and idle eviction", async () => {
    const { dataDirectory, repository, startupGate, supervisor } =
      await fixture({
        gateStartup: true,
        profileIdleTimeoutMs: 1_000,
      });
    const sessionId = "restart-stop-race";
    const profileDirectory = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
    );
    const processFile = path.join(profileDirectory, "process.pid");
    const opening = supervisor.open(
      openCommand(sessionId, repository, "primary"),
    );
    await waitForFile(path.join(profileDirectory, "launch-args.json"));
    await writeFile(startupGate!, "ready\n");
    await opening;
    const firstPid = await readFile(processFile, "utf8");
    await rm(startupGate!, { force: true });

    process.kill(Number(firstPid), "SIGKILL");
    const restartedPid = await waitForFileChange(processFile, firstPid);
    const stopping = supervisor.stop(sessionId);
    await writeFile(startupGate!, "ready\n");

    await expect(stopping).resolves.toMatchObject({ status: "stopped" });
    await supervisor.evictIdleSessions(Date.now() + 2_000);
    const replacement = await supervisor.open(
      openCommand("restart-race-replacement", repository, "secondary"),
    );
    expect(await readFile(processFile, "utf8")).not.toBe(restartedPid);
    expect(replacement.status).toBe("running");
  });

  it("rolls back an in-flight open before shutdown completes", async () => {
    const { dataDirectory, repository, startupGate, supervisor } =
      await fixture({ gateStartup: true });
    const sessionId = "shutdown-during-open";
    const profileDirectory = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
    );
    const opening = supervisor.open(
      openCommand(sessionId, repository, "primary"),
    );
    await waitForFile(path.join(profileDirectory, "launch-args.json"));

    const closing = supervisor.close();
    await writeFile(startupGate!, "ready\n");

    await expect(opening).rejects.toThrow("supervisor is stopped");
    await expect(closing).resolves.toBeUndefined();
    expect(() => supervisor.status(sessionId)).toThrow("is not open");
    await expect(
      readdir(path.join(dataDirectory, "code", "workspaces"), {
        recursive: true,
      }).then((entries) =>
        entries.filter((entry) => entry.endsWith(".code-workspace")),
      ),
    ).resolves.toEqual([]);
    await expect(
      readdir(path.join(dataDirectory, "code", "sessions"), {
        recursive: true,
      }),
    ).resolves.toEqual([]);
    expect(
      await readFile(
        path.join(dataDirectory, "code", "state", "runtime.json"),
        "utf8",
      ),
    ).not.toContain(sessionId);
  });

  it("retires a stale workspace incarnation when the same session moves", async () => {
    const { repository, supervisor } = await fixture();
    const replacement = path.join(path.dirname(repository), "replacement");
    await mkdir(replacement);
    const command = openCommand("moving", repository, "primary");
    const first = await supervisor.open(command);
    const firstTarget = supervisor.proxyTarget(command.sessionId);
    const firstWorkspace = JSON.parse(
      await readFile(new URL(firstTarget.workspaceUri), "utf8"),
    ) as { settings: Record<string, string> };
    const staleBridge = await openSocket(
      firstWorkspace.settings["cantrip.bridgeUrl"]!,
    );
    const staleBridgeClosed = new Promise<number>((resolve) => {
      staleBridge.once("close", (code) => resolve(code));
    });

    const moved = await supervisor.open({ ...command, cwd: replacement });
    const movedTarget = supervisor.proxyTarget(command.sessionId);
    const movedWorkspace = JSON.parse(
      await readFile(new URL(movedTarget.workspaceUri), "utf8"),
    ) as { folders: Array<{ path: string }> };
    const canonicalReplacement = await realpath(replacement);

    expect(moved.processInstanceId).toBe(first.processInstanceId);
    expect(movedTarget.workspaceUri).not.toBe(firstTarget.workspaceUri);
    expect(movedWorkspace.folders).toEqual([
      {
        name: path.basename(canonicalReplacement),
        path: canonicalReplacement,
      },
    ]);
    expect(JSON.stringify(movedWorkspace)).not.toContain(repository);
    await expect(
      readFile(new URL(firstTarget.workspaceUri), "utf8"),
    ).rejects.toThrow();
    await expect(staleBridgeClosed).resolves.toBe(1000);
  });

  it("multiplexes more sessions than the legacy advertised limit", async () => {
    const { repository, supervisor } = await fixture();
    const sessions = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        supervisor.open(
          openCommand(`unbounded-${index}`, repository, `tree-${index}`),
        ),
      ),
    );

    expect(
      new Set(sessions.map((session) => session.processInstanceId)),
    ).toEqual(new Set([sessions[0]?.processInstanceId]));

    await Promise.all(
      sessions
        .slice(0, -1)
        .map((session) => supervisor.stop(session.sessionId)),
    );
    expect(supervisor.status("unbounded-7").status).toBe("running");
    expect(supervisor.proxyTarget("unbounded-7").processInstanceId).toBe(
      sessions.at(-1)?.processInstanceId,
    );
  });

  it("treats stopping an already-removed session as success", async () => {
    const { repository, supervisor } = await fixture();
    await supervisor.open(openCommand("disposable", repository, "primary"));
    await supervisor.stop("disposable");

    await expect(supervisor.stop("disposable")).resolves.toMatchObject({
      sessionId: "disposable",
      status: "stopped",
      processInstanceId: null,
    });
  });

  it("keeps an idle profile warm for the next editor attachment", async () => {
    const { dataDirectory, repository, supervisor } = await fixture();
    const first = await supervisor.open(
      openCommand("first-editor", repository, "primary"),
    );
    await supervisor.stop("first-editor");

    const second = await supervisor.open(
      openCommand("second-editor", repository, "primary"),
    );
    expect(second.processInstanceId).toBe(first.processInstanceId);
    const profileDirectory = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
    );
    expect(
      (
        await readFile(
          path.join(profileDirectory, "health-requests.log"),
          "utf8",
        )
      )
        .trim()
        .split("\n"),
    ).toEqual(["true", "true"]);
  });

  it("restarts a cached profile that no longer serves authenticated HTTP", async () => {
    const { dataDirectory, repository, supervisor } = await fixture({
      readinessTimeoutMs: 500,
    });
    const first = await supervisor.open(
      openCommand("healthy-editor", repository, "primary"),
    );
    const profileDirectory = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
    );
    const firstPid = await readFile(
      path.join(profileDirectory, "process.pid"),
      "utf8",
    );
    await writeFile(path.join(profileDirectory, "unhealthy.pid"), firstPid);

    const recovered = await supervisor.open(
      openCommand("recovered-editor", repository, "secondary"),
    );
    expect(recovered.processInstanceId).not.toBe(first.processInstanceId);
    expect(
      await readFile(path.join(profileDirectory, "process.pid"), "utf8"),
    ).not.toBe(firstPid);
    expect(supervisor.status("healthy-editor")).toMatchObject({
      status: "running",
      processInstanceId: recovered.processInstanceId,
    });
  });

  it("removes every workspace incarnation when the supervisor closes", async () => {
    const { repository, supervisor } = await fixture();
    await Promise.all([
      supervisor.open(openCommand("close-one", repository, "primary")),
      supervisor.open(openCommand("close-two", repository, "feature")),
    ]);
    const workspaceUris = [
      supervisor.proxyTarget("close-one").workspaceUri,
      supervisor.proxyTarget("close-two").workspaceUri,
    ];

    await supervisor.close();

    for (const workspaceUri of workspaceUris) {
      await expect(readFile(new URL(workspaceUri), "utf8")).rejects.toThrow();
    }
  });

  it("evicts a warm profile after its idle timeout", async () => {
    const { repository, supervisor } = await fixture({
      idleSweepIntervalMs: 60_000,
      profileIdleTimeoutMs: 1_000,
    });
    const first = await supervisor.open(
      openCommand("first-idle-editor", repository, "primary"),
    );
    await supervisor.stop("first-idle-editor");
    await supervisor.evictIdleSessions(Date.now() + 2_000);

    const second = await supervisor.open(
      openCommand("second-idle-editor", repository, "primary"),
    );
    expect(second.processInstanceId).not.toBe(first.processInstanceId);
  });

  it("shares a persistent profile process and always writes the Cantrip theme", async () => {
    const { dataDirectory, repository, supervisor } = await fixture();
    const profileDirectory = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
    );
    const staleExtensionCache = path.join(
      profileDirectory,
      "user-data",
      "CachedProfilesData",
      "__default__profile__",
      "extensions.builtin.cache",
    );
    await mkdir(path.dirname(staleExtensionCache), { recursive: true });
    await writeFile(staleExtensionCache, "stale");
    const first = await supervisor.open({
      ...openCommand("one", repository, "primary"),
      themeMode: "independent",
    });
    const second = await supervisor.open(
      openCommand("two", repository, "feature"),
    );

    expect(first.status).toBe("running");
    expect(second.processInstanceId).toBe(first.processInstanceId);
    const firstTarget = supervisor.proxyTarget("one");
    const secondTarget = supervisor.proxyTarget("two");
    expect(secondTarget.editorOrigin).toBe(firstTarget.editorOrigin);
    expect(secondTarget.workspaceUri).not.toBe(firstTarget.workspaceUri);

    const workspace = JSON.parse(
      await readFile(new URL(firstTarget.workspaceUri), "utf8"),
    ) as {
      folders: Array<{ path: string }>;
      settings: Record<string, unknown>;
    };
    expect(workspace.folders[0]?.path).toBe(await realpath(repository));
    expect(workspace.settings).toMatchObject({
      "cantrip.appearance": "dark",
      "cantrip.sessionId": "one",
      "cantrip.worktreeId": "primary",
      "security.workspace.trust.enabled": false,
      "window.title": "Command Palette",
      "workbench.secondarySideBar.defaultVisibility": "hidden",
      "workbench.colorTheme": "Cantrip Dark",
    });
    await expect(readFile(staleExtensionCache, "utf8")).rejects.toThrow();
    await expect(
      readFile(path.join(profileDirectory, ".cantrip-code-build"), "utf8"),
    ).resolves.toBe(`${"a".repeat(64)}\n`);
    const launchArguments = JSON.parse(
      await readFile(
        path.join(profileDirectory, "user-data", "launch-args.json"),
        "utf8",
      ),
    ) as string[];
    expect(launchArguments).toContain("--disable-workspace-trust");
    expect(launchArguments).not.toContain("--disable-extension");
    expect(firstTarget.workspaceUri).toContain(
      path.basename(path.join(dataDirectory, "code")),
    );

    await supervisor.stop("one");
    expect(supervisor.status("two").status).toBe("running");
    await supervisor.stop("two");

    const state = await readFile(
      path.join(dataDirectory, "code", "state", "runtime.json"),
      "utf8",
    );
    expect(state).not.toContain(firstTarget.connectionToken);
    expect(state).not.toContain("cantrip.bridgeToken");
  });

  it("reconfigures a compatibility workbench as editor-only and opens a safe relative file", async () => {
    const { repository, supervisor } = await fixture();
    const canonicalRepository = await realpath(repository);
    await writeFile(path.join(repository, "example.ts"), "export {};\n");
    await writeFile(path.join(repository, "second.ts"), "export {};\n");
    await supervisor.open({
      ...openCommand("editor", repository, "primary"),
      initialFile: "example.ts",
      presentation: "workbench",
    });
    const target = supervisor.proxyTarget("editor");
    let workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, unknown> };
    expect(workspace.settings).toMatchObject({
      "cantrip.presentation": "workbench",
    });
    expect(workspace.settings).not.toHaveProperty("cantrip.initialFile");

    const socket = await openSocket(
      workspace.settings["cantrip.bridgeUrl"] as string,
    );
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as {
        id: string;
        method: string;
        params: { expectedWorkspaceRootUri?: string; path?: string };
      };
      if (request.method === "openFile") {
        expect(request.params).toEqual({
          expectedWorkspaceRootUri: pathToFileURL(canonicalRepository).href,
          path: "second.ts",
        });
      }
      socket.send(
        JSON.stringify({
          type: "response",
          id: request.id,
          ok: true,
          result:
            request.method === "openFile"
              ? { relativePath: request.params.path }
              : { applied: true },
        }),
      );
    });

    await supervisor.setPresentation("editor", "editor");
    workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, unknown> };
    expect(workspace.settings).toMatchObject({
      "breadcrumbs.enabled": false,
      "cantrip.presentation": "editor",
      "window.commandCenter": false,
      "workbench.activityBar.location": "hidden",
      "workbench.editor.editorActionsLocation": "hidden",
      "workbench.editor.empty.hint": "hidden",
      "workbench.editor.showTabs": "none",
      "workbench.layoutControl.enabled": false,
      "workbench.startupEditor": "none",
      "workbench.statusBar.visible": false,
    });
    expect(workspace.settings).not.toHaveProperty("window.menuBarVisibility");

    await expect(supervisor.openFile("editor", "second.ts")).resolves.toEqual({
      relativePath: "second.ts",
    });
    workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, unknown> };
    expect(workspace.settings).not.toHaveProperty("cantrip.initialFile");
    await expect(
      supervisor.openFile("editor", "../outside.ts"),
    ).rejects.toThrow("safe worktree-relative file path");
    socket.close();
  });

  it("binds workspace navigation to the canonical worktree root", async () => {
    const { repository, supervisor } = await fixture();
    const repositoryAlias = path.join(
      path.dirname(repository),
      "repository-alias",
    );
    await symlink(repository, repositoryAlias, "dir");
    await writeFile(path.join(repository, "canonical.ts"), "export {};\n");
    await supervisor.open(
      openCommand("canonical-root", repositoryAlias, "primary"),
    );

    const target = supervisor.proxyTarget("canonical-root");
    const workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as {
      folders: Array<{ name: string; path: string }>;
      settings: Record<string, unknown>;
    };
    const canonicalRoot = await realpath(repository);
    expect(workspace.folders).toEqual([
      { name: path.basename(canonicalRoot), path: canonicalRoot },
    ]);
    const socket = await openSocket(
      workspace.settings["cantrip.bridgeUrl"] as string,
    );
    const openRequest = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as {
          id: string;
          method: string;
          params: Record<string, unknown>;
        };
        if (request.method === "openFile") resolve(request.params);
        socket.send(
          JSON.stringify({
            type: "response",
            id: request.id,
            ok: true,
            result:
              request.method === "openFile"
                ? { relativePath: request.params.path }
                : { applied: true },
          }),
        );
      });
    });

    await expect(
      supervisor.openFile("canonical-root", "canonical.ts"),
    ).resolves.toEqual({ relativePath: "canonical.ts" });
    await expect(openRequest).resolves.toEqual({
      expectedWorkspaceRootUri: pathToFileURL(canonicalRoot).href,
      path: "canonical.ts",
    });
    socket.close();
  });

  it("rejects missing files and symlinks outside the authorized worktree", async () => {
    const { repository, supervisor } = await fixture();
    const outside = path.join(path.dirname(repository), "outside.ts");
    await writeFile(outside, "private\n");
    await symlink(outside, path.join(repository, "outside-link.ts"));

    await expect(
      supervisor.open({
        ...openCommand("missing-file", repository, "primary"),
        initialFile: "missing.ts",
      }),
    ).rejects.toThrow("does not exist");
    await expect(
      supervisor.open({
        ...openCommand("escaping-link", repository, "primary"),
        initialFile: "outside-link.ts",
      }),
    ).rejects.toThrow("outside the authorized worktree");
  });

  it("prepares dirty editors and reports bounded agent file changes", async () => {
    const { repository, supervisor } = await fixture();
    await supervisor.open(openCommand("safe-turn", repository, "primary"));
    const target = supervisor.proxyTarget("safe-turn");
    const workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, string> };
    const socket = await openSocket(workspace.settings["cantrip.bridgeUrl"]!);
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as {
        id: string;
        method: string;
        params: { paths?: string[] };
      };
      if (request.method === "prepareAgentTurn") {
        socket.send(
          JSON.stringify({
            type: "response",
            id: request.id,
            ok: true,
            result: {
              allowed: true,
              policy: "always",
              dirtyEditors: [],
              saved: ["file:///repository/src/index.ts"],
              failed: [],
              reason: null,
            },
          }),
        );
      } else if (request.method === "agentTurnState") {
        expect(request.params.paths).toEqual(["src/index.ts"]);
        socket.send(
          JSON.stringify({
            type: "response",
            id: request.id,
            ok: true,
            result: { refreshed: ["src/index.ts"], conflicts: [] },
          }),
        );
      }
    });

    await expect(
      supervisor.prepareAgentTurn(repository),
    ).resolves.toMatchObject({
      prepared: true,
      sessions: [{ sessionId: "safe-turn", allowed: true }],
    });
    await expect(
      supervisor.agentTurnState(repository, "completed", [
        "src/index.ts",
        "../outside.ts",
      ]),
    ).resolves.toEqual({
      notifiedSessions: 1,
      refreshed: ["src/index.ts"],
      conflicts: [],
    });
    socket.close();
  });

  it("restores compatible session identity and eagerly prewarms its profile", async () => {
    const {
      capabilities,
      dataDirectory,
      installation,
      repository,
      supervisor,
    } = await fixture();
    await writeFile(path.join(repository, "restored.ts"), "export {};\n");
    const command = {
      ...openCommand("restored", repository, "primary"),
      initialFile: "restored.ts",
    };
    const first = await supervisor.open(command);
    await supervisor.close();
    const stateFile = path.join(dataDirectory, "code", "state", "runtime.json");
    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(persisted.sessions[0]?.initialFile).toBe("restored.ts");
    persisted.sessions.push({
      ...persisted.sessions[0],
      codeTabId: "tab-orphaned-editor",
      presentation: "editor",
      sessionId: "orphaned-editor",
    });
    await writeFile(stateFile, `${JSON.stringify(persisted, null, 2)}\n`);

    const restored = new CodeSupervisor({
      capabilities,
      dataDirectory,
      installation,
      readinessTimeoutMs: 3_000,
    });
    supervisors.push(restored);
    await restored.start();
    expect(restored.status("restored")).toMatchObject({
      status: "running",
    });
    expect(restored.proxyTarget("restored").workspaceUri).toBe(
      first.workspaceUri,
    );
    const restoredWorkspace = JSON.parse(
      await readFile(
        new URL(restored.proxyTarget("restored").workspaceUri),
        "utf8",
      ),
    ) as { settings: Record<string, unknown> };
    expect(restoredWorkspace.settings).not.toHaveProperty(
      "cantrip.initialFile",
    );
    expect(() => restored.status("orphaned-editor")).toThrow("is not open");
    const reopened = await restored.open(command);
    expect(reopened.status).toBe("running");
    expect(reopened.processInstanceId).not.toBe(first.processInstanceId);
    expect(reopened.processInstanceId).toBe(
      restored.status("restored").processInstanceId,
    );
  });

  it("does not persist temporary editor-only sessions", async () => {
    const {
      capabilities,
      dataDirectory,
      installation,
      repository,
      supervisor,
    } = await fixture();
    await supervisor.open({
      ...openCommand("temporary-editor", repository, "primary"),
      presentation: "editor",
    });
    await supervisor.close();

    const state = await readFile(
      path.join(dataDirectory, "code", "state", "runtime.json"),
      "utf8",
    );
    expect(state).not.toContain("temporary-editor");

    const restored = new CodeSupervisor({
      capabilities,
      dataDirectory,
      installation,
      readinessTimeoutMs: 3_000,
    });
    supervisors.push(restored);
    await restored.start();
    expect(() => restored.status("temporary-editor")).toThrow("is not open");
  });

  it("makes compatibility sessions ephemeral before bridge acknowledgement", async () => {
    const bridge = new CodeWorkbenchBridge({ requestTimeoutMs: 50 });
    const { dataDirectory, repository, supervisor } = await fixture({ bridge });
    await supervisor.open(
      openCommand("compatibility-editor", repository, "primary"),
    );
    const target = supervisor.proxyTarget("compatibility-editor");
    const workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, string> };
    const socket = await openSocket(workspace.settings["cantrip.bridgeUrl"]!);

    await expect(
      supervisor.setPresentation("compatibility-editor", "editor"),
    ).rejects.toThrow("timed out");
    const state = await readFile(
      path.join(dataDirectory, "code", "state", "runtime.json"),
      "utf8",
    );
    expect(state).not.toContain("compatibility-editor");
    socket.close();
  });

  it("evicts detached editor-only sessions sooner than durable workbenches", async () => {
    const { repository, supervisor } = await fixture({
      editorIdleTimeoutMs: 1_000,
      idleSweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });
    await supervisor.open(openCommand("durable", repository, "primary"));
    await supervisor.open({
      ...openCommand("temporary", repository, "primary"),
      presentation: "editor",
    });

    await expect(
      supervisor.evictIdleSessions(Date.now() + 2_000),
    ).resolves.toEqual(["temporary"]);
    expect(supervisor.status("durable").status).toBe("running");
  });

  it("evicts unattached idle sessions but preserves active tunnel streams", async () => {
    const { repository, supervisor } = await fixture({
      idleSweepIntervalMs: 60_000,
      idleTimeoutMs: 1_000,
    });
    await supervisor.open(openCommand("idle", repository, "primary"));
    supervisor.beginTunnelStream("idle", "attachment\0stream");
    await expect(
      supervisor.evictIdleSessions(Date.now() + 2_000),
    ).resolves.toEqual([]);
    supervisor.endTunnelStream("idle", "attachment\0stream");
    await expect(
      supervisor.evictIdleSessions(Date.now() + 2_000),
    ).resolves.toEqual(["idle"]);
    expect(() => supervisor.status("idle")).toThrow("is not open");
  });
});
