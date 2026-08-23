import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  CodeAgentTurnNotificationResult,
  CodeAgentTurnPreparationResult,
  CodeAppearance,
  CodeCapabilities,
  CodeOpenFileResult,
  CodePresentation,
  CodeProbeResult,
  CodeRuntimeStatus,
  CodeSaveAllResult,
  CodeThemeMode,
  WorkerCommand,
} from "@cantrip/protocol";
import {
  codeAgentTurnNotificationResultSchema,
  codeAgentTurnPreparationResultSchema,
  codeAppearanceSchema,
} from "@cantrip/protocol";

import { workerLogError, workerLogger } from "../logger.js";
import type { CantripCodeInstallation } from "./installation.js";
import { spawnGuardedProcess } from "./process-guard.js";
import { CodeWorkbenchBridge } from "./workbench-bridge.js";

type CodeOpenCommand = Extract<WorkerCommand, { type: "code.open" }>;

interface CodeSession {
  activeTunnelStreams: Set<string>;
  appearance: CodeAppearance;
  bridgeToken: string;
  bridgeUrl: string;
  codeTabId: string;
  cwd: string;
  initialFile: string | null;
  lastActivityAt: string;
  lastError: string | null;
  profileId: string;
  profileKey: string;
  presentation: CodePresentation;
  projectId: string;
  projectName: string;
  sessionId: string;
  startedAt: string | null;
  status: CodeRuntimeStatus["status"];
  themeMode: CodeThemeMode;
  workspacePath: string;
  workspaceIncarnation: string;
  workspaceRootPath: string;
  workspaceRootUri: string;
  workspaceUri: string;
  worktreeId: string;
  worktreeName: string;
}

interface ProfileProcess {
  child: ChildProcess | null;
  connectionToken: string | null;
  crashTimes: number[];
  instanceId: string | null;
  idleSinceMs: number | null;
  launchPromise: Promise<void> | null;
  logPath: string;
  port: number | null;
  profileId: string;
  profileKey: string;
  ready: boolean;
  restartTimer: ReturnType<typeof setTimeout> | null;
  sessions: Set<string>;
  stopping: boolean;
}

export interface CodeProxyTarget {
  codeTabId: string;
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
  editorIdleTimeoutMs?: number;
  idleSweepIntervalMs?: number;
  idleTimeoutMs?: number;
  profileIdleTimeoutMs?: number;
  readinessTimeoutMs?: number;
  workerId?: string;
  workerName?: string;
}

const MAX_CRASHES_PER_WINDOW = 5;
const CRASH_WINDOW_MS = 5 * 60_000;
const PROCESS_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_EDITOR_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_PROFILE_IDLE_TIMEOUT_MS = 30 * 60_000;
const MAX_RESTORED_SESSION_RECORDS = 10_000;
const RUNTIME_STATE_SCHEMA_VERSION = 2;
const PROFILE_BUILD_FINGERPRINT_FILE = ".cantrip-code-build";

const THEME_NAMES: Record<CodeAppearance, string> = {
  light: "Cantrip Light",
  dark: "Cantrip Dark",
  "high-contrast-light": "Cantrip High Contrast Light",
  "high-contrast-dark": "Cantrip High Contrast Dark",
  "pro-light": "Cantrip Pro Light",
  "pro-dark": "Cantrip Pro Dark",
  "pro-high-contrast-light": "Cantrip Pro High Contrast Light",
  "pro-high-contrast-dark": "Cantrip Pro High Contrast Dark",
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

function sameBinding(
  session: CodeSession,
  command: CodeOpenCommand,
  workspaceRootPath: string,
): boolean {
  return (
    session.codeTabId === command.codeTabId &&
    session.projectId === command.projectId &&
    session.worktreeId === command.worktreeId &&
    session.cwd === path.resolve(command.cwd) &&
    session.workspaceRootPath === workspaceRootPath &&
    session.profileKey === stableKey(command.profileId) &&
    session.presentation === command.presentation
  );
}

export class CodeSupervisor {
  readonly #bridge: CodeWorkbenchBridge;
  readonly #capabilities: CodeCapabilities;
  readonly #codeRoot: string;
  readonly #editorIdleTimeoutMs: number;
  readonly #installation: CantripCodeInstallation | null;
  readonly #idleSweepIntervalMs: number;
  readonly #idleTimeoutMs: number;
  readonly #openOperations = new Map<string, Promise<CodeRuntimeStatus>>();
  readonly #profileOperations = new Map<string, Promise<ProfileProcess>>();
  readonly #profiles = new Map<string, ProfileProcess>();
  readonly #profileIdleTimeoutMs: number;
  readonly #readinessTimeoutMs: number;
  readonly #sessions = new Map<string, CodeSession>();
  readonly #workerId: string;
  readonly #workerName: string;
  #closed = false;
  #idleSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CodeSupervisorOptions) {
    this.#bridge = options.bridge ?? new CodeWorkbenchBridge();
    this.#capabilities = options.capabilities;
    this.#codeRoot = path.join(options.dataDirectory, "code");
    this.#installation = options.installation;
    this.#editorIdleTimeoutMs = Math.max(
      1_000,
      options.editorIdleTimeoutMs ?? DEFAULT_EDITOR_IDLE_TIMEOUT_MS,
    );
    this.#idleTimeoutMs = Math.max(
      1_000,
      options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    );
    this.#profileIdleTimeoutMs = Math.max(
      1_000,
      options.profileIdleTimeoutMs ?? DEFAULT_PROFILE_IDLE_TIMEOUT_MS,
    );
    this.#idleSweepIntervalMs = Math.max(
      1_000,
      options.idleSweepIntervalMs ??
        Math.min(
          60_000,
          Math.min(
            this.#idleTimeoutMs,
            this.#editorIdleTimeoutMs,
            this.#profileIdleTimeoutMs,
          ) / 4,
        ),
    );
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
    await this.#restoreState();
    await this.#prewarmRestoredProfiles();
    this.#idleSweepTimer = setInterval(() => {
      void this.evictIdleSessions().catch(() => undefined);
    }, this.#idleSweepIntervalMs);
    this.#idleSweepTimer.unref();
  }

  probe(): CodeProbeResult {
    return {
      capabilities: this.#capabilities,
      editorBuild: this.#installation?.editorBuild ?? null,
    };
  }

  async open(command: CodeOpenCommand): Promise<CodeRuntimeStatus> {
    const previous = this.#openOperations.get(command.sessionId);
    const operation = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.#open(command));
    this.#openOperations.set(command.sessionId, operation);
    try {
      return await operation;
    } finally {
      if (this.#openOperations.get(command.sessionId) === operation) {
        this.#openOperations.delete(command.sessionId);
      }
    }
  }

  async #open(command: CodeOpenCommand): Promise<CodeRuntimeStatus> {
    const startedAtMs = Date.now();
    this.#assertAvailable();
    if (this.#closed) throw new Error("Cantrip Code supervisor is stopped.");
    const cwd = path.resolve(command.cwd);
    workerLogger.event("info", "Cantrip Code session open requested", {
      event: "code.session.opening",
      subsystem: "code",
      operation: "open",
      status: "started",
      appearance: command.appearance,
      codeTabId: command.codeTabId,
      projectId: command.projectId,
      sessionId: command.sessionId,
      worktreeId: command.worktreeId,
    });
    const cwdStat = await stat(cwd).catch(() => null);
    if (!cwdStat?.isDirectory()) {
      throw new Error(`Cantrip Code worktree does not exist: ${cwd}`);
    }
    const workspaceRootPath = await realpath(cwd);
    const workspaceRootUri = pathToFileURL(workspaceRootPath).href;
    const initialFile = command.initialFile
      ? await this.#authorizedRelativeFile(
          workspaceRootPath,
          command.initialFile,
        )
      : null;

    const current = this.#sessions.get(command.sessionId);
    if (current && !sameBinding(current, command, workspaceRootPath)) {
      await this.stop(command.sessionId);
    }
    if (!this.#sessions.has(command.sessionId)) {
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
      const bridgeUrl = this.#bridge.register(
        command.sessionId,
        bridgeToken,
        command.appearance,
      );
      const workspaceIncarnation = randomUUID();
      const workspacePath = path.join(
        workspaceDirectory,
        `${stableKey(command.worktreeId)}-${sessionKey}-${workspaceIncarnation}.code-workspace`,
      );
      const session: CodeSession = {
        activeTunnelStreams: new Set(),
        appearance: command.appearance,
        bridgeToken,
        bridgeUrl,
        codeTabId: command.codeTabId,
        cwd,
        initialFile,
        lastActivityAt: isoNow(),
        lastError: null,
        profileId: command.profileId,
        profileKey,
        presentation: command.presentation,
        projectId: command.projectId,
        projectName: path.basename(cwd),
        sessionId: command.sessionId,
        startedAt: null,
        status: "starting",
        themeMode: "follow-cantrip",
        workspaceIncarnation,
        workspacePath,
        workspaceRootPath,
        workspaceRootUri,
        workspaceUri: pathToFileURL(workspacePath).href,
        worktreeId: command.worktreeId,
        worktreeName: command.worktreeName ?? command.worktreeId,
      };
      this.#sessions.set(command.sessionId, session);
      const profile = await this.#profile(command.profileId, profileKey);
      profile.sessions.add(command.sessionId);
      profile.idleSinceMs = null;
      await this.#writeWorkspace(session);
      workerLogger.event("debug", "Cantrip Code workspace prepared", {
        event: "code.workspace.prepared",
        subsystem: "code",
        operation: "prepare-workspace",
        status: "completed",
        appearance: session.appearance,
        sessionId: session.sessionId,
        projectId: session.projectId,
        worktreeId: session.worktreeId,
      });
    }

    const session = this.#sessions.get(command.sessionId)!;
    session.appearance = command.appearance;
    if (initialFile) session.initialFile = initialFile;
    session.themeMode = "follow-cantrip";
    session.profileId = command.profileId;
    session.presentation = command.presentation;
    session.worktreeName = command.worktreeName ?? session.worktreeName;
    session.lastActivityAt = isoNow();
    session.lastError = null;
    session.status = "starting";
    await this.#writeWorkspace(session);
    try {
      const profile = this.#profiles.get(session.profileKey)!;
      await this.#ensureProfile(profile);
      void this.#bridge
        .setTheme(session.sessionId, session.appearance)
        .catch((error) =>
          workerLogger.event(
            "warn",
            "Cantrip Code startup theme delivery failed",
            {
              event: "code.theme.delivery-failed",
              subsystem: "code",
              operation: "set-theme",
              reasonCode: "bridge-delivery-failed",
              status: "degraded",
              appearance: session.appearance,
              error: workerLogError(error),
              sessionId: session.sessionId,
            },
          ),
        );
      session.status = "running";
      session.startedAt ??= isoNow();
      session.lastActivityAt = isoNow();
      await this.#persistState();
      const status = this.#status(session);
      workerLogger.event("info", "Cantrip Code session is running", {
        event: "code.session.running",
        subsystem: "code",
        operation: "open",
        status: "completed",
        appearance: session.appearance,
        bridgeConnected: status.bridgeConnected,
        codeTabId: session.codeTabId,
        durationMs: Date.now() - startedAtMs,
        processInstanceId: status.processInstanceId,
        sessionId: session.sessionId,
      });
      return status;
    } catch (error) {
      session.status = "failed";
      session.lastError =
        error instanceof Error ? error.message : String(error);
      session.lastActivityAt = isoNow();
      await this.#persistState();
      workerLogger.event("error", "Cantrip Code session failed to open", {
        event: "code.session.open-failed",
        subsystem: "code",
        operation: "open",
        reasonCode: "session-start-failed",
        status: "failed",
        codeTabId: session.codeTabId,
        durationMs: Date.now() - startedAtMs,
        error: workerLogError(error),
        sessionId: session.sessionId,
      });
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

  async openFile(
    sessionId: string,
    requestedPath: string,
  ): Promise<CodeOpenFileResult> {
    const session = this.#requireSession(sessionId);
    const relativePath = await this.#authorizedRelativeFile(
      session.workspaceRootPath,
      requestedPath,
    );
    session.initialFile = relativePath;
    await this.#writeWorkspace(session);
    session.lastActivityAt = isoNow();
    return this.#bridge.openFile(
      sessionId,
      relativePath,
      session.workspaceRootUri,
    );
  }

  async setPresentation(
    sessionId: string,
    presentation: CodePresentation,
  ): Promise<CodeRuntimeStatus> {
    const session = this.#requireSession(sessionId);
    session.presentation = presentation;
    session.lastActivityAt = isoNow();
    await this.#writeWorkspace(session);
    await this.#persistState();
    await this.#bridge.setPresentation(sessionId, presentation);
    return this.#status(session);
  }

  async setTheme(
    sessionId: string,
    _themeMode: CodeThemeMode,
    appearance: CodeAppearance,
  ): Promise<CodeRuntimeStatus> {
    const session = this.#requireSession(sessionId);
    session.themeMode = "follow-cantrip";
    session.appearance = appearance;
    session.lastActivityAt = isoNow();
    workerLogger.event("debug", "Cantrip Code theme update requested", {
      event: "code.theme.updating",
      subsystem: "code",
      operation: "set-theme",
      status: "started",
      appearance,
      sessionId,
    });
    await this.#writeWorkspace(session);
    await this.#bridge.setTheme(sessionId, appearance);
    await this.#persistState();
    const status = this.#status(session);
    workerLogger.event("debug", "Cantrip Code theme update persisted", {
      event: "code.theme.updated",
      subsystem: "code",
      operation: "set-theme",
      status: "completed",
      appearance,
      bridgeConnected: status.bridgeConnected,
      processInstanceId: status.processInstanceId,
      sessionId,
    });
    return status;
  }

  async prepareAgentTurn(cwd: string): Promise<CodeAgentTurnPreparationResult> {
    const sessions = this.#sessionsForCwd(cwd);
    for (const session of sessions) session.lastActivityAt = isoNow();
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
    const sessions = this.#sessionsForCwd(cwd);
    for (const session of sessions) session.lastActivityAt = isoNow();
    const results = await Promise.all(
      sessions.map((session) =>
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
    this.#assertAvailable();
    const session = this.#sessions.get(sessionId);
    if (!session) return this.#stoppedStatus(sessionId);
    session.status = "stopping";
    session.lastActivityAt = isoNow();
    const profile = this.#profiles.get(session.profileKey);
    profile?.sessions.delete(sessionId);
    if (profile?.sessions.size === 0) profile.idleSinceMs = Date.now();
    this.#bridge.unregister(sessionId);
    session.status = "stopped";
    this.#sessions.delete(sessionId);
    await Promise.all([
      this.#persistState(),
      rm(session.workspacePath, { force: true }),
    ]);
    return this.#stoppedStatus(sessionId);
  }

  proxyTarget(sessionId: string): CodeProxyTarget {
    const session = this.#requireSession(sessionId);
    session.lastActivityAt = isoNow();
    const profile = this.#profiles.get(session.profileKey);
    if (
      !profile?.child ||
      profile.port === null ||
      !profile.connectionToken ||
      !profile.instanceId ||
      !profile.ready
    ) {
      throw new Error("Cantrip Code session is not running.");
    }
    return {
      codeTabId: session.codeTabId,
      connectionToken: profile.connectionToken,
      editorOrigin: `http://127.0.0.1:${profile.port}`,
      processInstanceId: profile.instanceId,
      workspaceUri: session.workspaceUri,
    };
  }

  beginTunnelStream(sessionId: string, streamId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.activeTunnelStreams.add(streamId);
    session.lastActivityAt = isoNow();
  }

  endTunnelStream(sessionId: string, streamId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.activeTunnelStreams.delete(streamId);
    session.lastActivityAt = isoNow();
  }

  async evictIdleSessions(now = Date.now()): Promise<string[]> {
    if (this.#closed) return [];
    const candidates = [...this.#sessions.values()]
      .filter((session) => this.#isIdle(session, now))
      .map((session) => session.sessionId);
    const evicted: string[] = [];
    for (const sessionId of candidates) {
      const session = this.#sessions.get(sessionId);
      if (!session || !this.#isIdle(session, now)) continue;
      await this.stop(sessionId);
      evicted.push(sessionId);
    }
    const idleProfiles = [...this.#profiles.values()].filter(
      (profile) =>
        profile.sessions.size === 0 &&
        profile.idleSinceMs !== null &&
        now - profile.idleSinceMs >= this.#profileIdleTimeoutMs,
    );
    for (const profile of idleProfiles) {
      if (
        profile.sessions.size !== 0 ||
        profile.idleSinceMs === null ||
        now - profile.idleSinceMs < this.#profileIdleTimeoutMs
      ) {
        continue;
      }
      await this.#terminateProfile(profile);
      if (profile.sessions.size === 0) {
        this.#profiles.delete(profile.profileKey);
      }
    }
    return evicted;
  }

  #isIdle(session: CodeSession, now: number): boolean {
    const idleTimeoutMs =
      session.presentation === "editor"
        ? this.#editorIdleTimeoutMs
        : this.#idleTimeoutMs;
    return (
      session.status !== "starting" &&
      session.status !== "stopping" &&
      session.activeTunnelStreams.size === 0 &&
      now - Date.parse(session.lastActivityAt) >= idleTimeoutMs
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#idleSweepTimer) {
      clearInterval(this.#idleSweepTimer);
      this.#idleSweepTimer = null;
    }
    await Promise.allSettled(this.#openOperations.values());
    this.#openOperations.clear();
    const now = isoNow();
    for (const session of this.#sessions.values()) {
      this.#bridge.unregister(session.sessionId);
      session.activeTunnelStreams.clear();
      session.status = "offline";
      session.lastActivityAt = now;
      session.lastError = null;
    }
    await Promise.all(
      [...this.#profiles.values()].map((profile) =>
        this.#terminateProfile(profile),
      ),
    );
    const cleanupResults = await Promise.allSettled([
      this.#persistState(),
      ...[...this.#sessions.values()].map((session) =>
        rm(session.workspacePath, { force: true }),
      ),
    ]);
    this.#sessions.clear();
    this.#profiles.clear();
    await this.#bridge.close();
    const cleanupFailures = cleanupResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        cleanupFailures,
        "Cantrip Code supervisor cleanup failed.",
      );
    }
  }

  async #profile(
    profileId: string,
    profileKey: string,
  ): Promise<ProfileProcess> {
    const existing = this.#profiles.get(profileKey);
    if (existing) return existing;
    const pending = this.#profileOperations.get(profileKey);
    if (pending) return pending;

    const operation = (async () => {
      const profileDirectory = path.join(
        this.#codeRoot,
        "profiles",
        profileKey,
      );
      await Promise.all([
        mkdir(path.join(profileDirectory, "user-data"), { recursive: true }),
        mkdir(path.join(profileDirectory, "extensions"), { recursive: true }),
        mkdir(path.join(profileDirectory, "server-data"), { recursive: true }),
      ]);
      const profile: ProfileProcess = {
        child: null,
        connectionToken: null,
        crashTimes: [],
        idleSinceMs: null,
        instanceId: null,
        launchPromise: null,
        logPath: path.join(this.#codeRoot, "logs", `${profileKey}.log`),
        port: null,
        profileId,
        profileKey,
        ready: false,
        restartTimer: null,
        sessions: new Set(),
        stopping: false,
      };
      this.#profiles.set(profileKey, profile);
      return profile;
    })();
    this.#profileOperations.set(profileKey, operation);
    try {
      return await operation;
    } finally {
      if (this.#profileOperations.get(profileKey) === operation) {
        this.#profileOperations.delete(profileKey);
      }
    }
  }

  async #ensureProfile(profile: ProfileProcess): Promise<void> {
    if (profile.child && profile.port !== null && profile.ready) return;
    if (profile.launchPromise) return profile.launchPromise;
    profile.launchPromise = this.#launchProfile(profile).finally(() => {
      profile.launchPromise = null;
    });
    return profile.launchPromise;
  }

  async #prewarmRestoredProfiles(): Promise<void> {
    if (!this.#installation || this.#profiles.size === 0) return;
    await Promise.all(
      [...this.#profiles.values()].map(async (profile) => {
        try {
          await this.#ensureProfile(profile);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await this.#log(
            profile.logPath,
            `profile prewarm failed: ${message}`,
          );
          for (const sessionId of profile.sessions) {
            const session = this.#sessions.get(sessionId);
            if (!session) continue;
            session.status = "offline";
            session.lastError = message;
            session.lastActivityAt = isoNow();
          }
        }
      }),
    );
    await this.#persistState();
  }

  async #launchProfile(profile: ProfileProcess): Promise<void> {
    const installation = this.#installation!;
    const profileDirectory = path.join(
      this.#codeRoot,
      "profiles",
      profile.profileKey,
    );
    await this.#prepareProfileForBuild(profileDirectory, installation);
    const port = await reserveLoopbackPort();
    const connectionToken = randomBytes(32).toString("hex");
    const instanceId = randomUUID();
    profile.stopping = false;
    profile.ready = false;
    profile.port = port;
    profile.connectionToken = connectionToken;
    profile.instanceId = instanceId;
    workerLogger.event("info", "Cantrip Code profile process starting", {
      event: "code.profile.starting",
      subsystem: "code",
      operation: "start-profile",
      status: "started",
      instanceId,
      profileKey: profile.profileKey,
      counts: { sessions: profile.sessions.size },
    });
    const args = [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--connection-token",
      connectionToken,
      "--accept-server-license-terms",
      "--disable-workspace-trust",
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
    const child = spawnGuardedProcess(installation.entrypoint, args, {
      cwd: installation.root,
      env: {
        ...process.env,
        CANTRIP_CODE_PROFILE_ID: profile.profileId,
      },
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
    profile.ready = true;
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
    workerLogger.event("info", "Cantrip Code profile process is ready", {
      event: "code.profile.ready",
      subsystem: "code",
      operation: "start-profile",
      status: "completed",
      instanceId,
      profileKey: profile.profileKey,
      counts: { sessions: profile.sessions.size },
    });
  }

  async #prepareProfileForBuild(
    profileDirectory: string,
    installation: CantripCodeInstallation,
  ): Promise<void> {
    const fingerprintPath = path.join(
      profileDirectory,
      PROFILE_BUILD_FINGERPRINT_FILE,
    );
    const fingerprint = installation.editorBuild.fingerprint;
    const previousFingerprint = await readFile(fingerprintPath, "utf8").catch(
      () => "",
    );
    if (previousFingerprint.trim() === fingerprint) return;

    // VS Code persists its built-in extension scan below CachedProfilesData.
    // Keeping that cache across a Cantrip Code upgrade can hide newly bundled
    // themes and extensions until the user deletes their profile manually.
    await rm(path.join(profileDirectory, "user-data", "CachedProfilesData"), {
      recursive: true,
      force: true,
    });
    await writeFile(fingerprintPath, `${fingerprint}\n`);
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
    profile.ready = false;
    const intentional = profile.stopping || this.#closed;
    const message = intentional
      ? null
      : `Cantrip Code exited (${signal ?? code ?? "unknown"}).`;
    await this.#log(
      profile.logPath,
      `process exited (${signal ?? code ?? "unknown"})${intentional ? " intentionally" : ""}`,
    );
    const processExitContext = {
      event: intentional ? "code.profile.stopped" : "code.profile.crashed",
      subsystem: "code",
      operation: "run-profile",
      status: intentional ? "completed" : "failed",
      reasonCode: intentional ? "requested" : "unexpected-exit",
      code,
      intentional,
      profileKey: profile.profileKey,
      counts: { sessions: profile.sessions.size },
      signal,
    };
    if (intentional) {
      workerLogger.info(
        "Cantrip Code profile process exited",
        processExitContext,
      );
    } else {
      workerLogger.error(
        "Cantrip Code profile process exited unexpectedly",
        processExitContext,
      );
    }
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
      "cantrip.appearance": session.appearance,
      "cantrip.bridgeToken": session.bridgeToken,
      "cantrip.bridgeUrl": session.bridgeUrl,
      "cantrip.projectId": session.projectId,
      "cantrip.projectName": session.projectName,
      "cantrip.presentation": session.presentation,
      "cantrip.sessionId": session.sessionId,
      "cantrip.workerId": this.#workerId,
      "cantrip.workerName": this.#workerName,
      "cantrip.worktreeId": session.worktreeId,
      "cantrip.worktreeName": session.worktreeName,
      "extensions.autoCheckUpdates": false,
      "extensions.autoUpdate": false,
      "security.workspace.trust.enabled": false,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "window.title": "Command Palette",
      "workbench.secondarySideBar.defaultVisibility": "hidden",
    };
    if (session.presentation === "editor") {
      Object.assign(settings, {
        "breadcrumbs.enabled": true,
        "window.commandCenter": false,
        "workbench.activityBar.location": "hidden",
        "workbench.editor.editorActionsLocation": "hidden",
        "workbench.editor.empty.hint": "hidden",
        "workbench.editor.showTabs": "none",
        "workbench.layoutControl.enabled": false,
        "workbench.startupEditor": "none",
        "workbench.statusBar.visible": true,
      });
    }
    settings["workbench.colorTheme"] = THEME_NAMES[session.appearance];
    const workspace = {
      folders: [
        {
          name: path.basename(session.workspaceRootPath),
          path: session.workspaceRootPath,
        },
      ],
      settings,
    };
    const temporary = `${session.workspacePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(workspace, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, session.workspacePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  #status(session: CodeSession): CodeRuntimeStatus {
    const profile = this.#profiles.get(session.profileKey);
    return {
      sessionId: session.sessionId,
      workspaceUri: session.workspaceUri,
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

  #stoppedStatus(sessionId: string): CodeRuntimeStatus {
    return {
      sessionId,
      status: "stopped",
      editorBuild: this.#installation!.editorBuild,
      processInstanceId: null,
      bridgeConnected: false,
      dirtyEditors: [],
      workbench: this.#bridge.state(sessionId),
      startedAt: null,
      lastActivityAt: isoNow(),
      lastError: null,
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

  async #authorizedRelativeFile(
    cwd: string,
    requestedPath: string,
  ): Promise<string> {
    const [relativePath] = this.#safeRelativePaths(cwd, [requestedPath]);
    const normalizedRequest = requestedPath.replaceAll("\\", "/");
    if (!relativePath || relativePath !== normalizedRequest) {
      throw new Error(
        "Cantrip Code requires a safe worktree-relative file path.",
      );
    }
    const [rootPath, filePath] = await Promise.all([
      realpath(cwd),
      realpath(path.resolve(cwd, relativePath)).catch(() => null),
    ]);
    if (!filePath) {
      throw new Error("The selected Cantrip Code file does not exist.");
    }
    const relativeTarget = path.relative(rootPath, filePath);
    if (
      !relativeTarget ||
      relativeTarget === ".." ||
      relativeTarget.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeTarget)
    ) {
      throw new Error(
        "The selected Cantrip Code file is outside the authorized worktree.",
      );
    }
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) {
      throw new Error("The selected Cantrip Code path is not a file.");
    }
    return relativePath;
  }

  async #restoreState(): Promise<void> {
    if (!this.#installation) return;
    const file = path.join(this.#codeRoot, "state", "runtime.json");
    let value: unknown;
    try {
      value = JSON.parse(await readFile(file, "utf8"));
    } catch {
      return;
    }
    if (
      typeof value !== "object" ||
      value === null ||
      (value as { schemaVersion?: unknown }).schemaVersion !==
        RUNTIME_STATE_SCHEMA_VERSION ||
      !Array.isArray((value as { sessions?: unknown }).sessions)
    ) {
      return;
    }
    const records = (value as { sessions: unknown[] }).sessions.slice(
      0,
      MAX_RESTORED_SESSION_RECORDS,
    );
    for (const record of records) {
      if (typeof record !== "object" || record === null) continue;
      const candidate = record as Record<string, unknown>;
      if (candidate.presentation === "editor") continue;
      const appearance = codeAppearanceSchema.safeParse(candidate.appearance);
      const requiredStrings = [
        "codeTabId",
        "cwd",
        "editorFingerprint",
        "profileId",
        "projectId",
        "projectName",
        "sessionId",
        "worktreeId",
        "worktreeName",
      ] as const;
      if (
        !appearance.success ||
        requiredStrings.some(
          (field) =>
            typeof candidate[field] !== "string" ||
            (candidate[field] as string).length === 0 ||
            (candidate[field] as string).length > 8_192,
        ) ||
        (candidate.profileId as string).length > 200 ||
        (candidate.projectName as string).length > 200 ||
        (candidate.worktreeName as string).length > 200 ||
        candidate.editorFingerprint !==
          this.#installation.editorBuild.fingerprint ||
        this.#sessions.has(candidate.sessionId as string)
      ) {
        continue;
      }
      const cwd = path.resolve(candidate.cwd as string);
      const workspaceRootPath = await realpath(cwd).catch(() => null);
      if (!workspaceRootPath) continue;
      const cwdStat = await stat(workspaceRootPath).catch(() => null);
      if (!cwdStat?.isDirectory()) continue;
      const workspaceRootUri = pathToFileURL(workspaceRootPath).href;
      const initialFile =
        typeof candidate.initialFile === "string"
          ? await this.#authorizedRelativeFile(
              workspaceRootPath,
              candidate.initialFile,
            ).catch(() => null)
          : null;
      const profileId = candidate.profileId as string;
      const profileKey = stableKey(profileId);
      const sessionId = candidate.sessionId as string;
      const projectId = candidate.projectId as string;
      const worktreeId = candidate.worktreeId as string;
      const sessionKey = stableKey(sessionId);
      const workspaceIncarnation =
        typeof candidate.workspaceIncarnation === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          candidate.workspaceIncarnation,
        )
          ? candidate.workspaceIncarnation
          : randomUUID();
      const workspaceDirectory = path.join(
        this.#codeRoot,
        "workspaces",
        stableKey(projectId),
      );
      await Promise.all([
        mkdir(workspaceDirectory, { recursive: true }),
        mkdir(path.join(this.#codeRoot, "sessions", sessionKey), {
          recursive: true,
        }),
      ]);
      const bridgeToken = randomBytes(32).toString("hex");
      const session: CodeSession = {
        activeTunnelStreams: new Set(),
        appearance: appearance.data,
        bridgeToken,
        bridgeUrl: this.#bridge.register(
          sessionId,
          bridgeToken,
          appearance.data,
        ),
        codeTabId: candidate.codeTabId as string,
        cwd,
        initialFile,
        lastActivityAt: isoNow(),
        lastError: null,
        profileId,
        profileKey,
        presentation:
          candidate.presentation === "editor" ? "editor" : "workbench",
        projectId,
        projectName: candidate.projectName as string,
        sessionId,
        startedAt:
          typeof candidate.startedAt === "string" &&
          Number.isFinite(Date.parse(candidate.startedAt))
            ? candidate.startedAt
            : null,
        status: "offline",
        themeMode: "follow-cantrip",
        workspaceIncarnation,
        workspacePath: path.join(
          workspaceDirectory,
          `${stableKey(worktreeId)}-${sessionKey}-${workspaceIncarnation}.code-workspace`,
        ),
        workspaceRootPath,
        workspaceRootUri,
        workspaceUri: "",
        worktreeId,
        worktreeName: candidate.worktreeName as string,
      };
      session.workspaceUri = pathToFileURL(session.workspacePath).href;
      this.#sessions.set(sessionId, session);
      const profile = await this.#profile(profileId, profileKey);
      profile.sessions.add(sessionId);
      await this.#writeWorkspace(session);
    }
    await this.#persistState();
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
    const sessions = [...this.#sessions.values()]
      .filter((session) => session.presentation === "workbench")
      .map((session) => ({
        appearance: session.appearance,
        codeTabId: session.codeTabId,
        cwd: session.cwd,
        initialFile: session.initialFile,
        editorFingerprint: this.#installation?.editorBuild.fingerprint ?? null,
        lastActivityAt: session.lastActivityAt,
        lastError: session.lastError,
        profileId: session.profileId,
        profileKey: session.profileKey,
        presentation: session.presentation,
        projectId: session.projectId,
        projectName: session.projectName,
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        status: session.status,
        themeMode: session.themeMode,
        workspaceIncarnation: session.workspaceIncarnation,
        workspacePath: session.workspacePath,
        worktreeId: session.worktreeId,
        worktreeName: session.worktreeName,
      }));
    await writeFile(
      temporary,
      `${JSON.stringify({ schemaVersion: RUNTIME_STATE_SCHEMA_VERSION, sessions }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, file);
  }
}
