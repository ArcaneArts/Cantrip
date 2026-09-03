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
  stat,
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
import { CodeDirectEndpointManager } from "../src/code/direct-endpoint.js";
import { CodeWorkbenchBridge } from "../src/code/workbench-bridge.js";
import {
  CodeSupervisor,
  renameWorkspaceFile,
  terminateCodeProcess,
  type CodeSupervisorOptions,
  waitForAuthenticatedCodeHttp,
} from "../src/code/supervisor.js";

describe("renameWorkspaceFile", () => {
  it("retries transient Windows file replacement failures", async () => {
    const attempts: string[] = [];
    const delays: number[] = [];
    await renameWorkspaceFile("workspace.tmp", "workspace.code-workspace", {
      platform: "win32",
      renameFile: async () => {
        attempts.push("rename");
        if (attempts.length < 3) {
          throw Object.assign(new Error("temporarily locked"), {
            code: attempts.length === 1 ? "EPERM" : "EBUSY",
          });
        }
      },
      wait: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    expect(attempts).toHaveLength(3);
    expect(delays).toEqual([25, 50]);
  });

  it("does not retry Windows-only errors on other platforms", async () => {
    const renameFile = vi.fn(async () => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });

    await expect(
      renameWorkspaceFile("workspace.tmp", "workspace.code-workspace", {
        platform: "darwin",
        renameFile,
        wait: async () => undefined,
      }),
    ).rejects.toThrow("denied");
    expect(renameFile).toHaveBeenCalledTimes(1);
  });
});

const directories: string[] = [];
const endpointManagers: CodeDirectEndpointManager[] = [];
const supervisors: CodeSupervisor[] = [];
const healthServers: NetServer[] = [];

afterEach(async () => {
  for (const endpoints of endpointManagers.splice(0)) endpoints.close();
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
  | "deferRestoredProfilePrewarm"
  | "editorIdleTimeoutMs"
  | "idleSweepIntervalMs"
  | "idleTimeoutMs"
  | "profileIdleTimeoutMs"
  | "profileLogWriter"
  | "profileCrashWindowMs"
  | "profileMaxCrashesPerWindow"
  | "profileRestartBaseDelayMs"
  | "profileRestartMaxDelayMs"
  | "prepareProfile"
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
  const workbenchContents = `${JSON.stringify({ name: "cantrip-workbench", version: "0.1.0" })}\n`;
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
    }),
  );
  const installation = await verifyCantripCodeInstallation(bundle);
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
  it("clears incomplete VSIX uploads and stale symlinks on restart", async () => {
    const { capabilities, dataDirectory, installation, supervisor } =
      await fixture();
    await supervisor.close();

    const vsixTempDirectory = supervisor.vsixTempDirectory();
    const incompleteUpload = path.join(
      vsixTempDirectory,
      "cantrip-code-vsix-incomplete",
    );
    await mkdir(incompleteUpload, { recursive: true });
    await writeFile(path.join(incompleteUpload, "upload.vsix"), "private");

    const restarted = new CodeSupervisor({
      capabilities,
      dataDirectory,
      installation,
      readinessTimeoutMs: 3_000,
    });
    supervisors.push(restarted);
    await restarted.start();
    expect(await readdir(vsixTempDirectory)).toEqual([]);
    await restarted.close();

    const outsideDirectory = path.join(dataDirectory, "outside-vsix");
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(path.join(outsideDirectory, "must-remain.txt"), "safe");
    await rm(vsixTempDirectory, { recursive: true, force: true });
    await symlink(
      outsideDirectory,
      vsixTempDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );

    const recovered = new CodeSupervisor({
      capabilities,
      dataDirectory,
      installation,
      readinessTimeoutMs: 3_000,
    });
    supervisors.push(recovered);
    await recovered.start();
    expect(await readdir(vsixTempDirectory)).toEqual([]);
    await expect(
      readFile(path.join(outsideDirectory, "must-remain.txt"), "utf8"),
    ).resolves.toBe("safe");
  });

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

  it.each(["openFile", "setPresentation"] as const)(
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
          : supervisor.setPresentation(sessionId, "editor");
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

  it("does not let unacknowledged theme delivery block presentation", async () => {
    const { repository, supervisor } = await fixture();
    const sessionId = "theme-before-presentation";
    await supervisor.open(openCommand(sessionId, repository, "primary"));
    const target = supervisor.proxyTarget(sessionId);
    const workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, string> };
    const bridge = await openControlledBridge(
      workspace.settings["cantrip.bridgeUrl"]!,
    );

    const themeRequestPromise = bridge.nextRequest();
    const themeUpdate = supervisor.setTheme(
      sessionId,
      "follow-cantrip",
      "light",
    );
    const themeRequest = await themeRequestPromise;
    expect(themeRequest.method).toBe("setTheme");
    await expect(themeUpdate).resolves.toMatchObject({ status: "running" });

    const presentationRequestPromise = bridge.nextRequest();
    const presentationUpdate = supervisor.setPresentation(sessionId, "editor");
    const presentationRequest = await presentationRequestPromise;
    expect(presentationRequest.method).toBe("setPresentation");
    bridge.respond(presentationRequest);
    await expect(presentationUpdate).resolves.toMatchObject({
      status: "running",
    });

    bridge.respond(themeRequest);
    bridge.socket.close();
  });

  it("cancels a disconnected open-file wait when stop arrives", async () => {
    const { repository, supervisor } = await fixture();
    const sessionId = "disconnected-open-file-stop";
    await writeFile(path.join(repository, "next.ts"), "export {};\n");
    await supervisor.open(openCommand(sessionId, repository, "primary"));
    const target = supervisor.proxyTarget(sessionId);
    const workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, string> };
    const mutation = supervisor.openFile(sessionId, "next.ts");
    const mutationFailure = expect(mutation).rejects.toThrow("superseded");
    await new Promise((resolve) => setImmediate(resolve));

    const stopping = supervisor.stop(sessionId);
    let remainedRoutable = true;
    try {
      supervisor.proxyTarget(sessionId);
    } catch {
      remainedRoutable = false;
    }
    const completed = Promise.all([mutationFailure, stopping]);
    const completedPromptly = await Promise.race([
      completed.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    if (!completedPromptly) {
      const bridge = await openControlledBridge(
        workspace.settings["cantrip.bridgeUrl"]!,
      );
      const request = await bridge.nextRequest();
      bridge.respond(request);
      await completed;
      bridge.socket.close();
    }

    expect(remainedRoutable).toBe(false);
    expect(completedPromptly).toBe(true);
  });

  it("does not let an old claimed stop retire a replacement incarnation", async () => {
    const { repository, supervisor } = await fixture();
    const sessionId = "claimed-stop-replacement";
    const replacement = path.join(path.dirname(repository), "replacement");
    await mkdir(replacement);
    await supervisor.open(openCommand(sessionId, repository, "primary"));
    const firstIncarnation = supervisor.status(sessionId).sessionIncarnationId;

    const claim = supervisor.claimStop(sessionId, firstIncarnation!);
    expect(claim.accepted).toBe(true);
    expect(() => supervisor.proxyTarget(sessionId)).toThrow("not running");
    const reopened = await supervisor.open({
      ...openCommand(sessionId, replacement, "replacement"),
      cwd: replacement,
    });
    expect(reopened.sessionIncarnationId).not.toBe(firstIncarnation);

    if (!claim.accepted) throw new Error("Expected the stop claim to succeed.");
    await claim.retire();

    expect(supervisor.status(sessionId)).toMatchObject({
      sessionIncarnationId: reopened.sessionIncarnationId,
      status: "running",
    });
    expect(supervisor.proxyTarget(sessionId).processInstanceId).toBe(
      reopened.processInstanceId,
    );
  });

  it("rejects a mismatched stop claim without changing the current session", async () => {
    const { repository, supervisor } = await fixture();
    const sessionId = "mismatched-stop-claim";
    const opened = await supervisor.open(
      openCommand(sessionId, repository, "primary"),
    );
    const target = supervisor.proxyTarget(sessionId);

    const claim = supervisor.claimStop(sessionId, crypto.randomUUID());

    expect(claim).toMatchObject({ accepted: false });
    if (claim.accepted)
      throw new Error("Expected the stop claim to be rejected.");
    expect(claim.status).toMatchObject({
      sessionIncarnationId: opened.sessionIncarnationId,
      status: "running",
    });
    expect(supervisor.proxyTarget(sessionId)).toEqual(target);
  });

  it("keeps missing-incarnation legacy stop claims unconditional", async () => {
    const { repository, supervisor } = await fixture();
    const sessionId = "legacy-stop-claim";
    await supervisor.open(openCommand(sessionId, repository, "primary"));

    const claim = supervisor.claimStop(sessionId);

    expect(claim.accepted).toBe(true);
    if (!claim.accepted) throw new Error("Expected the stop claim to succeed.");
    await expect(claim.retire()).resolves.toMatchObject({
      sessionIncarnationId: null,
      status: "stopped",
    });
    expect(() => supervisor.status(sessionId)).toThrow("is not open");
  });

  it("claims stop before draining a held direct control tail", async () => {
    const { repository, supervisor } = await fixture();
    const endpoints = new CodeDirectEndpointManager(supervisor);
    endpointManagers.push(endpoints);
    const sessionId = "claimed-direct-control-tail";
    await supervisor.open(openCommand(sessionId, repository, "primary"));
    const runtime = supervisor.status(sessionId);
    const workspace = JSON.parse(
      await readFile(
        new URL(supervisor.proxyTarget(sessionId).workspaceUri),
        "utf8",
      ),
    ) as { settings: Record<string, string> };
    const bridge = await openControlledBridge(
      workspace.settings["cantrip.bridgeUrl"]!,
    );
    const tunnelId = crypto.randomUUID();
    const endpoint = await endpoints.prepareProtected(tunnelId, sessionId);
    const blockedRequest = bridge.nextRequest();
    const control = fetch(
      `http://${endpoint.host}:${endpoint.port}/code/_cantrip/presentation`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ presentation: "editor" }),
      },
    ).catch(() => null);
    expect((await blockedRequest).method).toBe("setPresentation");

    const claim = supervisor.claimStop(
      sessionId,
      runtime.sessionIncarnationId!,
    );
    expect(claim.accepted).toBe(true);
    if (!claim.accepted) throw new Error("Expected the stop claim to succeed.");
    const completed = (async () => {
      await endpoints.closeSession(sessionId);
      return claim.retire();
    })();

    await expect(
      Promise.race([
        completed,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("Claimed direct stop did not complete.")),
            250,
          ),
        ),
      ]),
    ).resolves.toMatchObject({ status: "stopped" });
    expect(() => supervisor.status(sessionId)).toThrow("is not open");
    await control;
    bridge.socket.close();
  });

  it("keeps a direct endpoint alive when its stop claim mismatches", async () => {
    const { repository, supervisor } = await fixture();
    const endpoints = new CodeDirectEndpointManager(supervisor);
    endpointManagers.push(endpoints);
    const sessionId = "mismatched-direct-stop";
    await supervisor.open(openCommand(sessionId, repository, "primary"));
    const endpoint = await endpoints.prepareProtected(
      crypto.randomUUID(),
      sessionId,
    );

    const claim = supervisor.claimStop(sessionId, crypto.randomUUID());
    if (claim.accepted) {
      await endpoints.closeSession(sessionId);
      await claim.retire();
    }

    expect(claim.accepted).toBe(false);
    await expect(
      fetch(
        `http://${endpoint.host}:${endpoint.port}/code/_cantrip/health`,
      ).then((response) => response.status),
    ).resolves.toBe(200);
    expect(supervisor.proxyTarget(sessionId)).toBeDefined();
  });

  it.each(["openFile", "setPresentation"] as const)(
    "cancels a deferred %s bridge RPC when stop arrives",
    async (mutationKind) => {
      const { repository, supervisor } = await fixture();
      const sessionId = `deferred-${mutationKind}-stop`;
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
          : supervisor.setPresentation(sessionId, "editor");
      const mutationFailure = expect(mutation).rejects.toThrow("superseded");
      const request = await blockedRequest;
      expect(request.method).toBe(mutationKind);

      const stopping = supervisor.stop(sessionId);
      const completed = Promise.all([mutationFailure, stopping]);
      const completedPromptly = await Promise.race([
        completed.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      if (!completedPromptly) {
        bridge.respond(
          request,
          mutationKind === "openFile" ? { relativePath: "next.ts" } : {},
        );
        await completed;
      }

      expect(completedPromptly).toBe(true);
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

  it("keeps an incomplete new-open rollback owned and retryable", async () => {
    const { dataDirectory, repository, startupGate, supervisor } =
      await fixture({ gateStartup: true });
    const sessionId = "retryable-open-rollback";
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
    const provisional = supervisor.status(sessionId);
    const workspace = new URL(provisional.workspaceUri);
    await rm(workspace, { force: true });
    await mkdir(workspace);

    const stopping = supervisor.stop(sessionId);
    await writeFile(startupGate!, "ready\n");

    await expect(opening).rejects.toThrow("rollback was incomplete");
    await expect(stopping).rejects.toThrow("retirement cleanup failed");
    expect(() => supervisor.proxyTarget(sessionId)).toThrow("not running");
    expect(supervisor.status(sessionId)).toMatchObject({
      sessionIncarnationId: provisional.sessionIncarnationId,
      status: "stopping",
    });

    await rm(workspace, { recursive: true, force: true });
    await expect(supervisor.stop(sessionId)).resolves.toMatchObject({
      sessionIncarnationId: null,
      status: "stopped",
    });
    const replacement = await supervisor.open(
      openCommand(sessionId, repository, "primary"),
    );
    expect(replacement).toMatchObject({ status: "running" });
    expect(replacement.sessionIncarnationId).not.toBe(
      provisional.sessionIncarnationId,
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

  it("keeps a new session non-routable until open commits", async () => {
    let enterReadyLog: (() => void) | null = null;
    const readyLogEntered = new Promise<void>((resolve) => {
      enterReadyLog = resolve;
    });
    let releaseReadyLog: (() => void) | null = null;
    const readyLogRelease = new Promise<void>((resolve) => {
      releaseReadyLog = resolve;
    });
    const { repository, supervisor } = await fixture({
      profileLogWriter: async (_logPath, entry) => {
        if (!entry.includes(" ready on loopback port ")) return;
        enterReadyLog?.();
        await readyLogRelease;
      },
      readinessTimeoutMs: 1_000,
    });
    const sessionId = "provisional-open";
    const opening = supervisor.open(
      openCommand(sessionId, repository, "primary"),
    );
    const openingFailure = expect(opening).rejects.toThrow("superseded");

    await readyLogEntered;
    const statusBeforeCommit = supervisor.status(sessionId).status;
    let routableBeforeCommit = true;
    try {
      supervisor.proxyTarget(sessionId);
    } catch {
      routableBeforeCommit = false;
    }
    const stopping = supervisor.stop(sessionId);
    let routableAfterStop = true;
    try {
      supervisor.proxyTarget(sessionId);
    } catch {
      routableAfterStop = false;
    }
    releaseReadyLog?.();

    await openingFailure;
    await expect(stopping).resolves.toMatchObject({ status: "stopped" });
    expect(statusBeforeCommit).toBe("starting");
    expect(routableBeforeCommit).toBe(false);
    expect(routableAfterStop).toBe(false);
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

  it("does not let a stale process-exit continuation overwrite a healthy replacement", async () => {
    let observeExitLog: (() => void) | null = null;
    const exitLogObserved = new Promise<void>((resolve) => {
      observeExitLog = resolve;
    });
    let releaseExitLog: (() => void) | null = null;
    const exitLogRelease = new Promise<void>((resolve) => {
      releaseExitLog = resolve;
    });
    let holdFirstExitLog = true;
    const { dataDirectory, repository, supervisor } = await fixture({
      profileLogWriter: async (_logPath, entry) => {
        if (!holdFirstExitLog || !entry.includes("process exited")) return;
        holdFirstExitLog = false;
        observeExitLog?.();
        await exitLogRelease;
      },
      profileRestartBaseDelayMs: 10_000,
      profileRestartMaxDelayMs: 10_000,
    });
    const sessionId = "stale-process-exit";
    await supervisor.open(openCommand(sessionId, repository, "primary"));
    const processFile = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
      "process.pid",
    );
    const firstPid = await readFile(processFile, "utf8");

    process.kill(Number(firstPid), "SIGKILL");
    await exitLogObserved;
    await supervisor.prewarmProfile("default");
    const replacementPid = await readFile(processFile, "utf8");
    expect(replacementPid).not.toBe(firstPid);

    releaseExitLog?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(supervisor.status(sessionId)).toMatchObject({ status: "running" });
    expect(supervisor.proxyTarget(sessionId).processInstanceId).not.toBeNull();
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

  it("prewarms and retains the requested profile before its first session", async () => {
    const { dataDirectory, repository, supervisor } = await fixture({
      idleSweepIntervalMs: 60_000,
      profileIdleTimeoutMs: 1_000,
    });
    const profileDirectory = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
    );

    await supervisor.prewarmProfile("default");
    const prewarmedPid = await readFile(
      path.join(profileDirectory, "process.pid"),
      "utf8",
    );
    await supervisor.evictIdleSessions(Date.now() + 60_000);

    const opened = await supervisor.open(
      openCommand("prewarmed-editor", repository, "primary"),
    );
    expect(opened.status).toBe("running");
    expect(
      await readFile(path.join(profileDirectory, "process.pid"), "utf8"),
    ).toBe(prewarmedPid);
  });

  it("owns the profile settings path and prepares settings before launch", async () => {
    const prepared: string[] = [];
    const { dataDirectory, supervisor } = await fixture({
      prepareProfile: async (profileId) => {
        prepared.push(profileId);
      },
    });
    const expected = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
      "User",
      "settings.json",
    );
    expect(supervisor.profileSettingsPath("default")).toBe(expected);
    await supervisor.prewarmProfile("default");
    expect(prepared).toEqual(["default"]);
  });

  it("serializes the first session behind an in-flight profile prewarm", async () => {
    const { dataDirectory, repository, startupGate, supervisor } =
      await fixture({ gateStartup: true });
    const profileDirectory = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
    );
    const prewarm = supervisor.prewarmProfile("default");
    await waitForFile(path.join(profileDirectory, "launch-args.json"));
    const opening = supervisor.open(
      openCommand("prewarm-race", repository, "primary"),
    );

    await writeFile(startupGate!, "ready\n");
    await expect(prewarm).resolves.toBeUndefined();
    const runtime = await opening;
    expect(runtime.status).toBe("running");
    expect(
      await readFile(path.join(profileDirectory, "process.pid"), "utf8"),
    ).toMatch(/^\d+$/u);
  });

  it("deduplicates concurrent profile prewarm requests", async () => {
    const { dataDirectory, startupGate, supervisor } = await fixture({
      gateStartup: true,
    });
    const profileDirectory = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
    );
    const requests = [
      supervisor.prewarmProfile("default"),
      supervisor.prewarmProfile("default"),
      supervisor.prewarmProfile("default"),
    ];
    await waitForFile(path.join(profileDirectory, "launch-args.json"));

    await writeFile(startupGate!, "ready\n");
    await expect(Promise.all(requests)).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(
      (
        await readFile(
          path.join(profileDirectory, "health-requests.log"),
          "utf8",
        )
      )
        .trim()
        .split("\n"),
    ).toEqual(["true"]);
  });

  it("does not leak an in-flight profile prewarm across shutdown", async () => {
    const { dataDirectory, startupGate, supervisor } = await fixture({
      gateStartup: true,
    });
    const processFile = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
      "process.pid",
    );
    const prewarm = supervisor.prewarmProfile("default");
    await waitForFile(processFile);
    const pid = Number(await readFile(processFile, "utf8"));

    const closing = supervisor.close();
    await writeFile(startupGate!, "ready\n");

    await expect(prewarm).rejects.toThrow("stopped during prewarm");
    await expect(closing).resolves.toBeUndefined();
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("restarts a retained prewarm after it crashes without sessions", async () => {
    const { dataDirectory, supervisor } = await fixture();
    const processFile = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
      "process.pid",
    );
    await supervisor.prewarmProfile("default");
    const firstPid = await readFile(processFile, "utf8");

    process.kill(Number(firstPid), "SIGKILL");
    const restartedPid = await waitForFileChange(processFile, firstPid, 3_000);
    expect(restartedPid).toMatch(/^\d+$/u);
    expect(restartedPid).not.toBe(firstPid);
  });

  it("retries a retained prewarm when its first automatic restart fails", async () => {
    const { dataDirectory, entrypoint, supervisor } = await fixture({
      readinessTimeoutMs: 500,
    });
    const processFile = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
      "process.pid",
    );
    await supervisor.prewarmProfile("default");
    const firstPid = await readFile(processFile, "utf8");
    await writeFile(entrypoint, codeServerSource({ unhealthyStartup: true }));

    process.kill(Number(firstPid), "SIGKILL");
    const failedRestartPid = await waitForFileChange(processFile, firstPid);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await writeFile(entrypoint, codeServerSource());

    const recoveredPid = await waitForFileChange(
      processFile,
      failedRestartPid,
      2_000,
    );
    expect(recoveredPid).not.toBe(firstPid);
    expect(recoveredPid).not.toBe(failedRestartPid);
  });

  it("wakes a retained prewarm after its crash-breaker cooldown", async () => {
    const { dataDirectory, supervisor } = await fixture({
      profileCrashWindowMs: 400,
      profileMaxCrashesPerWindow: 1,
      profileRestartBaseDelayMs: 10,
      profileRestartMaxDelayMs: 10,
      readinessTimeoutMs: 1_000,
    });
    const processFile = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
      "process.pid",
    );
    await supervisor.prewarmProfile("default");
    const firstPid = await readFile(processFile, "utf8");

    process.kill(Number(firstPid), "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await readFile(processFile, "utf8")).toBe(firstPid);

    const recoveredPid = await waitForFileChange(processFile, firstPid, 1_500);
    expect(recoveredPid).not.toBe(firstPid);
  });

  it("functionally verifies an explicitly repeated retained prewarm", async () => {
    const { dataDirectory, supervisor } = await fixture({
      readinessTimeoutMs: 500,
    });
    const profileDirectory = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
    );
    const processFile = path.join(profileDirectory, "process.pid");
    await supervisor.prewarmProfile("default");
    const firstPid = await readFile(processFile, "utf8");
    await writeFile(path.join(profileDirectory, "unhealthy.pid"), firstPid);

    await supervisor.prewarmProfile("default");

    expect(await readFile(processFile, "utf8")).not.toBe(firstPid);
  });

  it("retries restored profile prewarm after a transient startup failure", async () => {
    const {
      capabilities,
      dataDirectory,
      entrypoint,
      installation,
      repository,
      supervisor,
    } = await fixture({ deferRestoredProfilePrewarm: true });
    await supervisor.open(
      openCommand("restored-prewarm-retry", repository, "primary"),
    );
    await supervisor.close();
    await writeFile(entrypoint, codeServerSource({ unhealthyStartup: true }));
    const restored = new CodeSupervisor({
      capabilities,
      dataDirectory,
      deferRestoredProfilePrewarm: true,
      installation,
      readinessTimeoutMs: 100,
    });
    supervisors.push(restored);
    await restored.start();
    const processFile = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
      "process.pid",
    );

    await restored.prewarmRestoredProfiles();
    const failedPid = await readFile(processFile, "utf8");
    await writeFile(entrypoint, codeServerSource());
    await restored.prewarmRestoredProfiles();

    expect(await waitForFileChange(processFile, failedPid, 2_000)).not.toBe(
      failedPid,
    );
  });

  it("serializes restored prewarm with retirement of its final session", async () => {
    const {
      capabilities,
      dataDirectory,
      installation,
      repository,
      supervisor,
    } = await fixture({ deferRestoredProfilePrewarm: true });
    const sessionId = "restored-prewarm-retirement";
    await supervisor.open(openCommand(sessionId, repository, "primary"));
    await supervisor.close();
    let releasePreparation: (() => void) | null = null;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let observePreparation: (() => void) | null = null;
    const preparationObserved = new Promise<void>((resolve) => {
      observePreparation = resolve;
    });
    const restored = new CodeSupervisor({
      capabilities,
      dataDirectory,
      deferRestoredProfilePrewarm: true,
      installation,
      prepareProfile: async () => {
        observePreparation?.();
        await preparationGate;
      },
      profileIdleTimeoutMs: 1_000,
      readinessTimeoutMs: 1_000,
    });
    supervisors.push(restored);
    await restored.start();

    const prewarm = restored.prewarmRestoredProfiles();
    await preparationObserved;
    let stopped = false;
    const stopping = restored.stop(sessionId).then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);

    releasePreparation?.();
    await Promise.all([prewarm, stopping]);
    const processFile = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "user-data",
      "process.pid",
    );
    const pid = Number(await readFile(processFile, "utf8"));
    await restored.evictIdleSessions(Date.now() + 2_000);
    expect(() => process.kill(pid, 0)).toThrow();
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

  it("removes the final per-session artifact directory on stop", async () => {
    const { dataDirectory, repository, supervisor } = await fixture();
    const sessionId = "session-artifact-cleanup";
    await supervisor.open(openCommand(sessionId, repository, "primary"));
    const sessionDirectory = path.join(
      dataDirectory,
      "code",
      "sessions",
      createHash("sha256").update(sessionId).digest("hex"),
    );
    await writeFile(path.join(sessionDirectory, "owned.tmp"), "owned\n");

    await supervisor.stop(sessionId);

    await expect(readdir(sessionDirectory)).rejects.toThrow();
  });

  it("keeps failed retirement cleanup non-routable and retryable", async () => {
    const { dataDirectory, repository, supervisor } = await fixture();
    const sessionId = "retryable-retirement-cleanup";
    const opened = await supervisor.open(
      openCommand(sessionId, repository, "primary"),
    );
    const workspace = new URL(supervisor.proxyTarget(sessionId).workspaceUri);
    await rm(workspace, { force: true });
    await mkdir(workspace);

    await expect(supervisor.stop(sessionId)).rejects.toThrow();
    expect(() => supervisor.proxyTarget(sessionId)).toThrow("not running");
    expect(supervisor.status(sessionId)).toMatchObject({
      sessionIncarnationId: opened.sessionIncarnationId,
      status: "stopping",
    });
    const stateFile = path.join(dataDirectory, "code", "state", "runtime.json");
    expect(await readFile(stateFile, "utf8")).not.toContain(sessionId);

    await rm(workspace, { recursive: true, force: true });
    await expect(supervisor.stop(sessionId)).resolves.toMatchObject({
      sessionIncarnationId: null,
      status: "stopped",
    });
    expect(() => supervisor.status(sessionId)).toThrow("is not open");

    const replacement = await supervisor.open(
      openCommand(sessionId, repository, "primary"),
    );
    expect(replacement.sessionIncarnationId).not.toBe(
      opened.sessionIncarnationId,
    );
    expect(await readFile(stateFile, "utf8")).toContain(sessionId);
  });

  it("removes failed runtime state temporary files", async () => {
    const { dataDirectory, repository, supervisor } = await fixture();
    const sessionId = "state-temp-cleanup";
    await supervisor.open(openCommand(sessionId, repository, "primary"));
    const stateDirectory = path.join(dataDirectory, "code", "state");
    const stateFile = path.join(stateDirectory, "runtime.json");
    await rm(stateFile, { force: true });
    await mkdir(stateFile);

    await expect(supervisor.stop(sessionId)).rejects.toThrow();
    const temporaryFiles = (await readdir(stateDirectory)).filter(
      (entry) => entry.startsWith("runtime.json.") && entry.endsWith(".tmp"),
    );

    await rm(stateFile, { recursive: true, force: true });
    await supervisor.stop(sessionId);
    expect(temporaryFiles).toEqual([]);
  });

  it("evicts a warm profile after its idle timeout", async () => {
    const { dataDirectory, repository, supervisor } = await fixture({
      idleSweepIntervalMs: 60_000,
      profileIdleTimeoutMs: 1_000,
    });
    const extensionMarker = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
      "extensions",
      "example.publisher",
      "installed.txt",
    );
    const first = await supervisor.open(
      openCommand("first-idle-editor", repository, "primary"),
    );
    await mkdir(path.dirname(extensionMarker), { recursive: true });
    await writeFile(extensionMarker, "persistent extension\n");
    await supervisor.stop("first-idle-editor");
    await supervisor.evictIdleSessions(Date.now() + 2_000);

    const second = await supervisor.open(
      openCommand("second-idle-editor", repository, "primary"),
    );
    expect(second.processInstanceId).not.toBe(first.processInstanceId);
    await expect(readFile(extensionMarker, "utf8")).resolves.toBe(
      "persistent extension\n",
    );
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
      "extensions.autoCheckUpdates": false,
      "extensions.autoUpdate": false,
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
    const { dataDirectory, repository, supervisor } = await fixture();
    const canonicalRepository = await realpath(repository);
    await writeFile(path.join(repository, "example.ts"), "export {};\n");
    await writeFile(path.join(repository, "second.ts"), "export {};\n");
    await supervisor.open({
      ...openCommand("editor", repository, "primary"),
      initialFile: "example.ts",
      presentation: "workbench",
    });
    const target = supervisor.proxyTarget("editor");
    expect(target.initialFileUri).toBe(
      pathToFileURL(path.join(canonicalRepository, "example.ts")).href,
    );
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
      "debug.toolBarLocation": "hidden",
      "editor.minimap.enabled": false,
      "extensions.ignoreRecommendations": true,
      "window.commandCenter": false,
      "workbench.activityBar.location": "hidden",
      "workbench.editor.editorActionsLocation": "hidden",
      "workbench.editor.empty.hint": "hidden",
      "workbench.editor.showTabs": "none",
      "workbench.layoutControl.enabled": false,
      "workbench.navigationControl.enabled": false,
      "workbench.startupEditor": "none",
      "workbench.statusBar.visible": false,
    });
    expect(workspace.settings).not.toHaveProperty("window.menuBarVisibility");

    const runtimePath = path.join(
      dataDirectory,
      "code",
      "state",
      "runtime.json",
    );
    const workspacePath = new URL(target.workspaceUri);
    const beforeOpenFile = {
      runtime: (await stat(runtimePath, { bigint: true })).ino,
      workspace: (await stat(workspacePath, { bigint: true })).ino,
    };

    await expect(supervisor.openFile("editor", "second.ts")).resolves.toEqual({
      relativePath: "second.ts",
    });
    expect((await stat(runtimePath, { bigint: true })).ino).toBe(
      beforeOpenFile.runtime,
    );
    expect((await stat(workspacePath, { bigint: true })).ino).toBe(
      beforeOpenFile.workspace,
    );
    workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, unknown> };
    expect(workspace.settings).not.toHaveProperty("cantrip.initialFile");

    await expect(
      supervisor.setPresentation("editor", "editor"),
    ).resolves.toMatchObject({ sessionId: "editor" });
    expect((await stat(runtimePath, { bigint: true })).ino).toBe(
      beforeOpenFile.runtime,
    );
    expect((await stat(workspacePath, { bigint: true })).ino).toBe(
      beforeOpenFile.workspace,
    );
    await expect(
      supervisor.openFile("editor", "../outside.ts"),
    ).rejects.toThrow("safe worktree-relative file path");
    socket.close();
  });

  it("persists workbench navigation without rewriting its workspace", async () => {
    const { dataDirectory, repository, supervisor } = await fixture();
    await writeFile(path.join(repository, "first.ts"), "export {}\n");
    await writeFile(path.join(repository, "second.ts"), "export {}\n");
    await supervisor.open({
      ...openCommand("durable-navigation", repository, "primary"),
      initialFile: "first.ts",
    });
    const target = supervisor.proxyTarget("durable-navigation");
    const workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, unknown> };
    const socket = await openSocket(
      workspace.settings["cantrip.bridgeUrl"] as string,
    );
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as BridgeRequest;
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
    const workspacePath = new URL(target.workspaceUri);
    const workspaceInode = (await stat(workspacePath, { bigint: true })).ino;

    await expect(
      supervisor.openFile("durable-navigation", "second.ts"),
    ).resolves.toEqual({ relativePath: "second.ts" });

    expect((await stat(workspacePath, { bigint: true })).ino).toBe(
      workspaceInode,
    );
    const persisted = JSON.parse(
      await readFile(
        path.join(dataDirectory, "code", "state", "runtime.json"),
        "utf8",
      ),
    ) as { sessions: Array<{ initialFile: string; sessionId: string }> };
    expect(
      persisted.sessions.find(
        (session) => session.sessionId === "durable-navigation",
      )?.initialFile,
    ).toBe("second.ts");
    expect(supervisor.proxyTarget("durable-navigation").initialFileUri).toBe(
      pathToFileURL(path.join(await realpath(repository), "second.ts")).href,
    );
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

  it("canonically authorizes startup file URIs before proxying them", async () => {
    const { repository, supervisor } = await fixture();
    const outside = path.join(path.dirname(repository), "startup-outside.ts");
    const inside = path.join(repository, "inside.ts");
    const outsideLink = path.join(repository, "startup-outside-link.ts");
    await writeFile(inside, "inside\n");
    await writeFile(outside, "outside\n");
    await symlink(outside, outsideLink);
    await supervisor.open(openCommand("startup-uri", repository, "primary"));
    const canonicalRepository = await realpath(repository);
    const canonicalInside = path.join(canonicalRepository, "inside.ts");
    const canonicalOutsideLink = path.join(
      canonicalRepository,
      "startup-outside-link.ts",
    );

    await expect(
      supervisor.authorizeStartupFileUri(
        "startup-uri",
        pathToFileURL(canonicalInside).href,
      ),
    ).resolves.toBe(pathToFileURL(canonicalInside).href);
    await expect(
      supervisor.authorizeStartupFileUri(
        "startup-uri",
        `${pathToFileURL(canonicalRepository).href}/%2e%2e%2fstartup-outside.ts`,
      ),
    ).rejects.toThrow("invalid startup file URI");
    await expect(
      supervisor.authorizeStartupFileUri(
        "startup-uri",
        pathToFileURL(canonicalOutsideLink).href,
      ),
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

  it("rolls back a restored record whose workspace cannot be hydrated", async () => {
    const {
      capabilities,
      dataDirectory,
      installation,
      repository,
      supervisor,
    } = await fixture();
    const sessionId = "failed-restored-hydration";
    const survivingSessionId = "surviving-restored-hydration";
    await supervisor.open({
      ...openCommand(sessionId, repository, "primary"),
      profileId: "broken-profile",
    });
    await supervisor.open(
      openCommand(survivingSessionId, repository, "secondary"),
    );
    await supervisor.close();
    const stateFile = path.join(dataDirectory, "code", "state", "runtime.json");
    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as {
      sessions: Array<{ sessionId: string; workspacePath: string }>;
    };
    const workspacePath = persisted.sessions.find(
      (session) => session.sessionId === sessionId,
    )!.workspacePath;
    await mkdir(workspacePath);
    const sessionDirectory = path.join(
      dataDirectory,
      "code",
      "sessions",
      createHash("sha256").update(sessionId).digest("hex"),
    );
    const processFile = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("broken-profile").digest("hex"),
      "user-data",
      "process.pid",
    );
    const bridge = new CodeWorkbenchBridge();
    const unregister = vi.spyOn(bridge, "unregister");
    const restored = new CodeSupervisor({
      bridge,
      capabilities,
      dataDirectory,
      installation,
      readinessTimeoutMs: 3_000,
    });
    supervisors.push(restored);

    const startError = await restored.start().then(
      () => null,
      (error: unknown) => error,
    );
    const retainedSession = (() => {
      try {
        return restored.status(sessionId);
      } catch {
        return null;
      }
    })();
    const survivingSession = restored.status(survivingSessionId);
    const persistedAfterRestore = await readFile(stateFile, "utf8");
    const sessionArtifactsRemain = await readdir(sessionDirectory)
      .then(() => true)
      .catch(() => false);
    const processStarted = await readFile(processFile, "utf8")
      .then((value) => {
        try {
          process.kill(Number(value), 0);
          return true;
        } catch {
          return false;
        }
      })
      .catch(() => false);
    const obstructionPreserved = await readdir(workspacePath)
      .then(() => true)
      .catch(() => false);
    await rm(workspacePath, { recursive: true, force: true });
    await restored.close().catch(() => undefined);

    expect(startError).toBeNull();
    expect(unregister).toHaveBeenCalledWith(sessionId);
    expect(retainedSession).toBeNull();
    expect(survivingSession.status).toBe("running");
    expect(persistedAfterRestore).not.toContain(sessionId);
    expect(sessionArtifactsRemain).toBe(false);
    expect(processStarted).toBe(false);
    expect(obstructionPreserved).toBe(true);
  });

  it("does not persist temporary editor-only sessions", async () => {
    const {
      capabilities,
      dataDirectory,
      installation,
      repository,
      supervisor,
    } = await fixture();
    const statePath = path.join(dataDirectory, "code", "state", "runtime.json");
    await writeFile(statePath, '{"sentinel":true}\n');
    const stateInode = (await stat(statePath, { bigint: true })).ino;
    await supervisor.open({
      ...openCommand("temporary-editor", repository, "primary"),
      presentation: "editor",
    });
    expect((await stat(statePath, { bigint: true })).ino).toBe(stateInode);
    await supervisor.close();

    const state = await readFile(statePath, "utf8");
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

  it("removes a durable record when an existing workbench reopens as editor-only", async () => {
    const { dataDirectory, repository, supervisor } = await fixture();
    const command = openCommand(
      "reopened-temporary-editor",
      repository,
      "primary",
    );
    await supervisor.open(command);
    const statePath = path.join(dataDirectory, "code", "state", "runtime.json");
    expect(await readFile(statePath, "utf8")).toContain(command.sessionId);

    await supervisor.open({ ...command, presentation: "editor" });

    expect(await readFile(statePath, "utf8")).not.toContain(command.sessionId);
  });

  it("opens graphical settings in an ephemeral folderless session", async () => {
    const {
      capabilities,
      dataDirectory,
      installation,
      repository,
      supervisor,
    } = await fixture();
    const sessionId = "ec77be8d-9623-4a2f-b488-48b23584b1fd";

    // A global settings workbench must not depend on a project or repository
    // remaining available on the worker.
    await rm(repository, { recursive: true, force: true });
    await expect(
      supervisor.openSettingsWorkbench({
        type: "code.settings.workbench.open",
        sessionId,
        profileId: "default",
        appearance: "dark",
      }),
    ).resolves.toMatchObject({ status: "running", sessionId });

    const target = supervisor.proxyTarget(sessionId);
    const workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as {
      folders: Array<{ path: string }>;
      settings: Record<string, unknown>;
    };
    expect(workspace.folders).toEqual([]);
    expect(workspace.settings).toMatchObject({
      "cantrip.presentation": "editor",
      "workbench.settings.editor": "ui",
      "workbench.activityBar.location": "hidden",
      "workbench.editor.showTabs": "none",
      "workbench.statusBar.visible": false,
    });

    const bridge = await openControlledBridge(
      workspace.settings["cantrip.bridgeUrl"] as string,
    );
    const requestPromise = bridge.nextRequest();
    const opening = supervisor.openSettings(sessionId);
    const request = await requestPromise;
    expect(request).toMatchObject({ method: "openSettings", params: {} });
    bridge.socket.send(
      JSON.stringify({
        type: "response",
        id: request.id,
        ok: true,
        result: { opened: true },
      }),
    );
    await expect(opening).resolves.toEqual({ opened: true });
    const extensionsRequestPromise = bridge.nextRequest();
    const extensionsOpening = supervisor.openExtensions(sessionId);
    const extensionsRequest = await extensionsRequestPromise;
    expect(extensionsRequest).toMatchObject({
      method: "openExtensions",
      params: {},
    });
    bridge.socket.send(
      JSON.stringify({
        type: "response",
        id: extensionsRequest.id,
        ok: true,
        result: { opened: true },
      }),
    );
    await expect(extensionsOpening).resolves.toEqual({ opened: true });
    expect(
      JSON.parse(await readFile(new URL(target.workspaceUri), "utf8")).settings,
    ).toMatchObject({
      "cantrip.presentation": "extensions",
      "extensions.autoCheckUpdates": false,
      "extensions.autoUpdate": false,
      "extensions.ignoreRecommendations": true,
    });
    const themeRequestPromise = bridge.nextRequest();
    const themeUpdate = supervisor.setTheme(
      sessionId,
      "follow-cantrip",
      "light",
    );
    const themeRequest = await themeRequestPromise;
    expect(themeRequest).toMatchObject({
      method: "setTheme",
      params: { appearance: "light" },
    });
    bridge.socket.send(
      JSON.stringify({
        type: "response",
        id: themeRequest.id,
        ok: true,
        result: { applied: true },
      }),
    );
    await expect(themeUpdate).resolves.toMatchObject({ status: "running" });
    expect(
      JSON.parse(await readFile(new URL(target.workspaceUri), "utf8")).settings,
    ).toMatchObject({
      "cantrip.appearance": "light",
      "cantrip.presentation": "extensions",
    });
    const vsixRequestPromise = bridge.nextRequest();
    const vsixInstallation = supervisor.installVsix(
      sessionId,
      "/tmp/cantrip-upload.vsix",
    );
    const vsixRequest = await vsixRequestPromise;
    expect(vsixRequest).toMatchObject({
      method: "installVsix",
      params: { path: "/tmp/cantrip-upload.vsix" },
    });
    bridge.socket.send(
      JSON.stringify({
        type: "response",
        id: vsixRequest.id,
        ok: true,
        result: { installed: true },
      }),
    );
    await expect(vsixInstallation).resolves.toEqual({ installed: true });
    const settingsAgainRequestPromise = bridge.nextRequest();
    const settingsAgain = supervisor.openSettings(sessionId);
    const settingsAgainRequest = await settingsAgainRequestPromise;
    expect(settingsAgainRequest).toMatchObject({
      method: "openSettings",
      params: {},
    });
    bridge.socket.send(
      JSON.stringify({
        type: "response",
        id: settingsAgainRequest.id,
        ok: true,
        result: { opened: true },
      }),
    );
    await expect(settingsAgain).resolves.toEqual({ opened: true });
    expect(
      JSON.parse(await readFile(new URL(target.workspaceUri), "utf8")).settings,
    ).toMatchObject({ "cantrip.presentation": "editor" });
    await expect(supervisor.openFile(sessionId, "anything.ts")).rejects.toThrow(
      "settings sessions cannot open files",
    );

    const stateFile = path.join(dataDirectory, "code", "state", "runtime.json");
    expect(
      await readFile(stateFile, "utf8").catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? "" : Promise.reject(error),
      ),
    ).not.toContain(sessionId);
    bridge.socket.close();
    await supervisor.close();

    const restored = new CodeSupervisor({
      capabilities,
      dataDirectory,
      installation,
      readinessTimeoutMs: 3_000,
    });
    supervisors.push(restored);
    await restored.start();
    expect(() => restored.status(sessionId)).toThrow("is not open");
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
