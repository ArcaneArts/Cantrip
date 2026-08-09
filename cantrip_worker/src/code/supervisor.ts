import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  CodeAgentTurnNotificationResult,
  CodeAgentTurnPreparationResult,
  CodeAppearance,
  CodeCapabilities,
  CodeProbeResult,
  CodeRuntimeStatus,
  CodeSaveAllResult,
  CodeThemeMode,
  WorkerCommand,
} from "@cantrip/protocol";
import {
  codeAgentTurnNotificationResultSchema,
  codeAgentTurnPreparationResultSchema,
} from "@cantrip/protocol";

import type { CantripCodeInstallation } from "./installation.js";
import { CodeWorkbenchBridge } from "./workbench-bridge.js";

type CodeOpenCommand = Extract<WorkerCommand, { type: "code.open" }>;

interface CodeSession {
  appearance: CodeAppearance;
  bridgeToken: string;
  bridgeUrl: string;
  codeTabId: string;
  cwd: string;
  lastActivityAt: string;
  lastError: string | null;
  profileKey: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  startedAt: string | null;
  status: CodeRuntimeStatus["status"];
  themeMode: CodeThemeMode;
  workspacePath: string;
  workspaceUri: string;
  worktreeId: string;
  worktreeName: string;
}

interface ProfileProcess {
  child: ChildProcess | null;
  connectionToken: string | null;
  crashTimes: number[];
  instanceId: string | null;
  launchPromise: Promise<void> | null;
  logPath: string;
  port: number | null;
  profileId: string;
  profileKey: string;
  restartTimer: ReturnType<typeof setTimeout> | null;
  sessions: Set<string>;
  stopping: boolean;
}

export interface CodeProxyTarget {
  connectionToken: string;
  editorOrigin: string;
  processInstanceId: string;
  workspaceUri: string;
}

export interface CodeSupervisorOptions {
  capabilities: CodeCapabilities;
  dataDirectory: string;
  installation: CantripCodeInstallation | null;
  bridge?: CodeWorkbenchBridge;
  readinessTimeoutMs?: number;
  workerId?: string;
  workerName?: string;
}

const MAX_CRASHES_PER_WINDOW = 5;
const CRASH_WINDOW_MS = 5 * 60_000;
const PROCESS_STOP_TIMEOUT_MS = 2_000;

const THEME_NAMES: Record<CodeAppearance, string> = {
  light: "Cantrip Light",
  dark: "Cantrip Dark",
  "high-contrast-light": "Cantrip High Contrast Light",
  "high-contrast-dark": "Cantrip High Contrast Dark",
};

function stableKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isoNow(): string {
  return new Date().toISOString();
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback port for Cantrip Code.");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForPort(
  child: ChildProcess,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        "Cantrip Code exited before its loopback server was ready.",
      );
    }
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      const finish = (value: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(250, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Cantrip Code did not become ready within ${timeoutMs}ms.`);
}

function sameBinding(session: CodeSession, command: CodeOpenCommand): boolean {
  return (
    session.codeTabId === command.codeTabId &&
    session.projectId === command.projectId &&
    session.worktreeId === command.worktreeId &&
    session.cwd === path.resolve(command.cwd) &&
    session.profileKey === stableKey(command.profileId)
  );
}

export class CodeSupervisor {
  readonly #bridge: CodeWorkbenchBridge;
  readonly #capabilities: CodeCapabilities;
  readonly #codeRoot: string;
  readonly #installation: CantripCodeInstallation | null;
  readonly #profiles = new Map<string, ProfileProcess>();
  readonly #readinessTimeoutMs: number;
  readonly #sessions = new Map<string, CodeSession>();
  readonly #workerId: string;
  readonly #workerName: string;
  #closed = false;

  constructor(options: CodeSupervisorOptions) {
    this.#bridge = options.bridge ?? new CodeWorkbenchBridge();
    this.#capabilities = options.capabilities;
    this.#codeRoot = path.join(options.dataDirectory, "code");
    this.#installation = options.installation;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 15_000;
    this.#workerId = options.workerId ?? "unknown-worker";
    this.#workerName = options.workerName ?? "Cantrip Worker";
  }

  async start(): Promise<void> {
    await Promise.all([
      mkdir(path.join(this.#codeRoot, "profiles"), { recursive: true }),
      mkdir(path.join(this.#codeRoot, "workspaces"), { recursive: true }),
      mkdir(path.join(this.#codeRoot, "sessions"), { recursive: true }),
      mkdir(path.join(this.#codeRoot, "state"), { recursive: true }),
      mkdir(path.join(this.#codeRoot, "logs"), { recursive: true }),
      this.#bridge.start(),
    ]);
  }

  probe(): CodeProbeResult {
    return {
      capabilities: this.#capabilities,
      editorBuild: this.#installation?.editorBuild ?? null,
    };
  }

  async open(command: CodeOpenCommand): Promise<CodeRuntimeStatus> {
    this.#assertAvailable();
    if (this.#closed) throw new Error("Cantrip Code supervisor is stopped.");
    const cwd = path.resolve(command.cwd);
    const cwdStat = await stat(cwd).catch(() => null);
    if (!cwdStat?.isDirectory()) {
      throw new Error(`Cantrip Code worktree does not exist: ${cwd}`);
    }

    const current = this.#sessions.get(command.sessionId);
    if (current && !sameBinding(current, command)) {
      await this.stop(command.sessionId);
    }
    if (!this.#sessions.has(command.sessionId)) {
      if (this.#sessions.size >= this.#capabilities.maxSessions) {
        throw new Error(
          `This worker supports at most ${this.#capabilities.maxSessions} concurrent Code sessions.`,
        );
      }
      const profileKey = stableKey(command.profileId);
      const sessionKey = stableKey(command.sessionId);
      const workspaceDirectory = path.join(
        this.#codeRoot,
        "workspaces",
        stableKey(command.projectId),
      );
      await Promise.all([
        mkdir(workspaceDirectory, { recursive: true }),
        mkdir(path.join(this.#codeRoot, "sessions", sessionKey), {
          recursive: true,
        }),
      ]);
      const bridgeToken = randomBytes(32).toString("hex");
      const bridgeUrl = this.#bridge.register(command.sessionId, bridgeToken);
      const workspacePath = path.join(
        workspaceDirectory,
        `${stableKey(command.worktreeId)}-${sessionKey}.code-workspace`,
      );
      const session: CodeSession = {
        appearance: command.appearance,
        bridgeToken,
        bridgeUrl,
        codeTabId: command.codeTabId,
        cwd,
        lastActivityAt: isoNow(),
        lastError: null,
        profileKey,
        projectId: command.projectId,
        projectName: command.projectName ?? path.basename(cwd),
        sessionId: command.sessionId,
        startedAt: null,
        status: "starting",
        themeMode: command.themeMode,
        workspacePath,
        workspaceUri: pathToFileURL(workspacePath).href,
        worktreeId: command.worktreeId,
        worktreeName: command.worktreeName ?? command.worktreeId,
      };
      this.#sessions.set(command.sessionId, session);
      const profile = await this.#profile(command.profileId, profileKey);
      profile.sessions.add(command.sessionId);
      await this.#writeWorkspace(session);
    }

    const session = this.#sessions.get(command.sessionId)!;
    session.appearance = command.appearance;
    session.themeMode = command.themeMode;
    session.projectName = command.projectName ?? session.projectName;
    session.worktreeName = command.worktreeName ?? session.worktreeName;
    session.lastActivityAt = isoNow();
    session.lastError = null;
    session.status = "starting";
    await this.#writeWorkspace(session);
    try {
      const profile = this.#profiles.get(session.profileKey)!;
      await this.#ensureProfile(profile);
      session.status = "running";
      session.startedAt ??= isoNow();
      session.lastActivityAt = isoNow();
      await this.#persistState();
      return this.#status(session);
    } catch (error) {
      session.status = "failed";
      session.lastError =
        error instanceof Error ? error.message : String(error);
      session.lastActivityAt = isoNow();
      await this.#persistState();
      throw error;
    }
  }

  status(sessionId: string): CodeRuntimeStatus {
    const session = this.#requireSession(sessionId);
    const profile = this.#profiles.get(session.profileKey);
    if (!profile?.child && session.status === "running")
      session.status = "offline";
    session.lastActivityAt = isoNow();
    return this.#status(session);
  }

  dirtyEditors(sessionId: string) {
    this.#requireSession(sessionId).lastActivityAt = isoNow();
    return this.#bridge.dirtyEditors(sessionId);
  }

  async saveAll(sessionId: string): Promise<CodeSaveAllResult> {
    this.#requireSession(sessionId).lastActivityAt = isoNow();
    return this.#bridge.saveAll(sessionId);
  }

  async setTheme(
    sessionId: string,
    themeMode: CodeThemeMode,
    appearance: CodeAppearance,
  ): Promise<CodeRuntimeStatus> {
    const session = this.#requireSession(sessionId);
    session.themeMode = themeMode;
    session.appearance = appearance;
    session.lastActivityAt = isoNow();
    await this.#writeWorkspace(session);
    await this.#bridge.setTheme(sessionId, themeMode, appearance);
    await this.#persistState();
    return this.#status(session);
  }

  async prepareAgentTurn(cwd: string): Promise<CodeAgentTurnPreparationResult> {
    const sessions = this.#sessionsForCwd(cwd);
    const prepared = await Promise.all(
      sessions.map((session) =>
        this.#bridge.prepareAgentTurn(session.sessionId),
      ),
    );
    return codeAgentTurnPreparationResultSchema.parse({
      prepared: prepared.every((session) => session.allowed),
      sessions: prepared,
    });
  }

  async agentTurnState(
    cwd: string,
    phase: "started" | "completed" | "failed",
    paths: string[],
  ): Promise<CodeAgentTurnNotificationResult> {
    const normalizedPaths = this.#safeRelativePaths(cwd, paths);
    const results = await Promise.all(
      this.#sessionsForCwd(cwd).map((session) =>
        this.#bridge.notifyAgentTurn(session.sessionId, phase, normalizedPaths),
      ),
    );
    return codeAgentTurnNotificationResultSchema.parse({
      notifiedSessions: results.reduce(
        (total, result) => total + result.notifiedSessions,
        0,
      ),
      refreshed: [...new Set(results.flatMap((result) => result.refreshed))],
      conflicts: results.flatMap((result) => result.conflicts),
    });
  }

  async stop(sessionId: string): Promise<CodeRuntimeStatus> {
    const session = this.#requireSession(sessionId);
    session.status = "stopping";
    session.lastActivityAt = isoNow();
    const profile = this.#profiles.get(session.profileKey);
    profile?.sessions.delete(sessionId);
    this.#bridge.unregister(sessionId);
    session.status = "stopped";
    const result = this.#status(session);
    this.#sessions.delete(sessionId);
    if (profile && profile.sessions.size === 0) {
      await this.#terminateProfile(profile);
      this.#profiles.delete(profile.profileKey);
    }
    await this.#persistState();
    return result;
  }

  proxyTarget(sessionId: string): CodeProxyTarget {
    const session = this.#requireSession(sessionId);
    const profile = this.#profiles.get(session.profileKey);
    if (
      !profile?.child ||
      profile.port === null ||
      !profile.connectionToken ||
      !profile.instanceId
    ) {
      throw new Error("Cantrip Code session is not running.");
    }
    return {
      connectionToken: profile.connectionToken,
      editorOrigin: `http://127.0.0.1:${profile.port}`,
      processInstanceId: profile.instanceId,
      workspaceUri: session.workspaceUri,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const sessionId of [...this.#sessions.keys()]) {
      this.#bridge.unregister(sessionId);
    }
    this.#sessions.clear();
    await Promise.all(
      [...this.#profiles.values()].map((profile) =>
        this.#terminateProfile(profile),
      ),
    );
    this.#profiles.clear();
    await this.#bridge.close();
    await this.#persistState();
  }

  async #profile(
    profileId: string,
    profileKey: string,
  ): Promise<ProfileProcess> {
    const existing = this.#profiles.get(profileKey);
    if (existing) return existing;
    const profileDirectory = path.join(this.#codeRoot, "profiles", profileKey);
    await Promise.all([
      mkdir(path.join(profileDirectory, "user-data"), { recursive: true }),
      mkdir(path.join(profileDirectory, "extensions"), { recursive: true }),
      mkdir(path.join(profileDirectory, "server-data"), { recursive: true }),
    ]);
    const profile: ProfileProcess = {
      child: null,
      connectionToken: null,
      crashTimes: [],
      instanceId: null,
      launchPromise: null,
      logPath: path.join(this.#codeRoot, "logs", `${profileKey}.log`),
      port: null,
      profileId,
      profileKey,
      restartTimer: null,
      sessions: new Set(),
      stopping: false,
    };
    this.#profiles.set(profileKey, profile);
    return profile;
  }

  async #ensureProfile(profile: ProfileProcess): Promise<void> {
    if (profile.child && profile.port !== null) return;
    if (profile.launchPromise) return profile.launchPromise;
    profile.launchPromise = this.#launchProfile(profile).finally(() => {
      profile.launchPromise = null;
    });
    return profile.launchPromise;
  }

  async #launchProfile(profile: ProfileProcess): Promise<void> {
    const installation = this.#installation!;
    const profileDirectory = path.join(
      this.#codeRoot,
      "profiles",
      profile.profileKey,
    );
    const port = await reserveLoopbackPort();
    const connectionToken = randomBytes(32).toString("hex");
    const instanceId = randomUUID();
    profile.stopping = false;
    profile.port = port;
    profile.connectionToken = connectionToken;
    profile.instanceId = instanceId;
    const args = [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--connection-token",
      connectionToken,
      "--accept-server-license-terms",
      "--server-data-dir",
      path.join(profileDirectory, "server-data"),
      "--user-data-dir",
      path.join(profileDirectory, "user-data"),
      "--extensions-dir",
      path.join(profileDirectory, "extensions"),
      "--telemetry-level",
      "off",
      "--disable-experiments",
      "--reconnection-grace-time",
      "300",
      "--log",
      "warn",
    ];
    const child = spawn(installation.entrypoint, args, {
      cwd: installation.root,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        CANTRIP_CODE_PROFILE_ID: profile.profileId,
      },
      shell:
        process.platform === "win32" &&
        [".bat", ".cmd"].includes(
          path.extname(installation.entrypoint).toLowerCase(),
        ),
      stdio: ["ignore", "pipe", "pipe"],
    });
    profile.child = child;
    this.#captureOutput(
      profile.logPath,
      child.stdout,
      connectionToken,
      "stdout",
    );
    this.#captureOutput(
      profile.logPath,
      child.stderr,
      connectionToken,
      "stderr",
    );
    child.once("exit", (code, signal) => {
      void this.#onProcessExit(profile, child, code, signal);
    });
    try {
      await waitForPort(child, port, this.#readinessTimeoutMs);
    } catch (error) {
      if (profile.child === child) this.#signalProcessTree(child, "SIGTERM");
      throw error;
    }
    if (profile.child !== child) {
      throw new Error("Cantrip Code process changed during startup.");
    }
    const now = isoNow();
    for (const sessionId of profile.sessions) {
      const session = this.#sessions.get(sessionId);
      if (!session) continue;
      session.status = "running";
      session.startedAt ??= now;
      session.lastActivityAt = now;
      session.lastError = null;
    }
    await this.#log(
      profile.logPath,
      `process ${instanceId} ready on loopback port ${port}`,
    );
  }

  async #onProcessExit(
    profile: ProfileProcess,
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (profile.child !== child) return;
    if (!profile.stopping && !this.#closed) {
      this.#signalProcessTree(child, "SIGTERM");
    }
    profile.child = null;
    profile.port = null;
    profile.connectionToken = null;
    profile.instanceId = null;
    const intentional = profile.stopping || this.#closed;
    const message = intentional
      ? null
      : `Cantrip Code exited (${signal ?? code ?? "unknown"}).`;
    await this.#log(
      profile.logPath,
      `process exited (${signal ?? code ?? "unknown"})${intentional ? " intentionally" : ""}`,
    );
    if (intentional || profile.sessions.size === 0) return;
    const now = Date.now();
    profile.crashTimes = profile.crashTimes.filter(
      (crash) => now - crash < CRASH_WINDOW_MS,
    );
    profile.crashTimes.push(now);
    for (const sessionId of profile.sessions) {
      const session = this.#sessions.get(sessionId);
      if (!session) continue;
      session.status = "offline";
      session.lastError = message;
      session.lastActivityAt = isoNow();
    }
    if (profile.crashTimes.length >= MAX_CRASHES_PER_WINDOW) {
      for (const sessionId of profile.sessions) {
        const session = this.#sessions.get(sessionId);
        if (!session) continue;
        session.status = "failed";
        session.lastError =
          "Cantrip Code stopped after repeatedly crashing. Restart it explicitly to try again.";
      }
      await this.#persistState();
      return;
    }
    const delay = Math.min(10_000, 250 * 2 ** (profile.crashTimes.length - 1));
    profile.restartTimer = setTimeout(() => {
      profile.restartTimer = null;
      void this.#ensureProfile(profile).catch(async (error) => {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        for (const sessionId of profile.sessions) {
          const session = this.#sessions.get(sessionId);
          if (!session) continue;
          session.status = "failed";
          session.lastError = errorMessage;
        }
        await this.#persistState();
      });
    }, delay);
    await this.#persistState();
  }

  async #terminateProfile(profile: ProfileProcess): Promise<void> {
    profile.stopping = true;
    if (profile.restartTimer) {
      clearTimeout(profile.restartTimer);
      profile.restartTimer = null;
    }
    const child = profile.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    this.#signalProcessTree(child, "SIGTERM");
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      exited,
      new Promise<void>(
        (resolve) =>
          (forceTimer = setTimeout(() => {
            this.#signalProcessTree(child, "SIGKILL");
            resolve();
          }, PROCESS_STOP_TIMEOUT_MS)),
      ),
    ]);
    if (forceTimer) clearTimeout(forceTimer);
  }

  #signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    if (process.platform === "win32") {
      const arguments_ = ["/PID", String(child.pid), "/T"];
      if (signal === "SIGKILL") arguments_.push("/F");
      const taskkill = spawn("taskkill", arguments_, {
        stdio: "ignore",
        windowsHide: true,
      });
      taskkill.once("error", () => child.kill(signal));
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }

  async #writeWorkspace(session: CodeSession): Promise<void> {
    const settings: Record<string, unknown> = {
      "cantrip.bridgeToken": session.bridgeToken,
      "cantrip.bridgeUrl": session.bridgeUrl,
      "cantrip.projectId": session.projectId,
      "cantrip.projectName": session.projectName,
      "cantrip.sessionId": session.sessionId,
      "cantrip.workerId": this.#workerId,
      "cantrip.workerName": this.#workerName,
      "cantrip.worktreeId": session.worktreeId,
      "cantrip.worktreeName": session.worktreeName,
      "extensions.autoCheckUpdates": false,
      "extensions.autoUpdate": false,
      "security.workspace.trust.enabled": true,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
    };
    if (session.themeMode === "follow-cantrip") {
      settings["workbench.colorTheme"] = THEME_NAMES[session.appearance];
    }
    const workspace = {
      folders: [{ name: path.basename(session.cwd), path: session.cwd }],
      settings,
    };
    await writeFile(
      session.workspacePath,
      `${JSON.stringify(workspace, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  #status(session: CodeSession): CodeRuntimeStatus {
    const profile = this.#profiles.get(session.profileKey);
    return {
      sessionId: session.sessionId,
      status: session.status,
      editorBuild: this.#installation!.editorBuild,
      processInstanceId: profile?.instanceId ?? null,
      bridgeConnected: this.#bridge.connected(session.sessionId),
      dirtyEditors: this.#bridge.dirtyEditors(session.sessionId),
      workbench: this.#bridge.state(session.sessionId),
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      lastError: session.lastError,
    };
  }

  #requireSession(sessionId: string): CodeSession {
    const session = this.#sessions.get(sessionId);
    if (!session)
      throw new Error(`Cantrip Code session ${sessionId} is not open.`);
    return session;
  }

  #sessionsForCwd(cwd: string): CodeSession[] {
    const resolved = path.resolve(cwd);
    return [...this.#sessions.values()].filter(
      (session) => session.cwd === resolved,
    );
  }

  #safeRelativePaths(cwd: string, paths: string[]): string[] {
    const root = path.resolve(cwd);
    const prefix = `${root}${path.sep}`;
    const result = new Set<string>();
    for (const candidate of paths.slice(0, 5_000)) {
      const absolute = path.resolve(root, candidate);
      if (absolute !== root && !absolute.startsWith(prefix)) continue;
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative) result.add(relative);
    }
    return [...result];
  }

  #assertAvailable(): void {
    if (!this.#capabilities.available || !this.#installation) {
      throw new Error(
        this.#capabilities.reason ??
          "Cantrip Code is unavailable on this worker.",
      );
    }
  }

  #captureOutput(
    logPath: string,
    stream: NodeJS.ReadableStream | null,
    secret: string,
    channel: string,
  ): void {
    if (!stream) return;
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        void this.#log(
          logPath,
          `${channel}: ${line.replaceAll(secret, "[redacted]")}`,
        );
      }
    });
    stream.once("end", () => {
      if (pending) {
        void this.#log(
          logPath,
          `${channel}: ${pending.replaceAll(secret, "[redacted]")}`,
        );
      }
    });
  }

  async #log(logPath: string, message: string): Promise<void> {
    await appendFile(logPath, `${isoNow()} ${message}\n`, "utf8").catch(
      () => undefined,
    );
  }

  async #persistState(): Promise<void> {
    const file = path.join(this.#codeRoot, "state", "runtime.json");
    const temporary = `${file}.${randomUUID()}.tmp`;
    const sessions = [...this.#sessions.values()].map((session) => ({
      codeTabId: session.codeTabId,
      cwd: session.cwd,
      lastActivityAt: session.lastActivityAt,
      lastError: session.lastError,
      profileKey: session.profileKey,
      projectId: session.projectId,
      projectName: session.projectName,
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      status: session.status,
      themeMode: session.themeMode,
      workspacePath: session.workspacePath,
      worktreeId: session.worktreeId,
      worktreeName: session.worktreeName,
    }));
    await writeFile(
      temporary,
      `${JSON.stringify({ schemaVersion: 1, sessions }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, file);
  }
}
