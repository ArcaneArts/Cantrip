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
import { request as requestHttp } from "node:http";
import { createServer } from "node:net";
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
  activityRevision: number;
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
  retainWarm: boolean;
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
  profileLogWriter?: (logPath: string, entry: string) => Promise<void>;
  readinessTimeoutMs?: number;
  workerId?: string;
  workerName?: string;
}

const MAX_CRASHES_PER_WINDOW = 5;
const CRASH_WINDOW_MS = 5 * 60_000;
const PROCESS_STOP_TIMEOUT_MS = 2_000;
const PROCESS_KILL_TIMEOUT_MS = 2_000;
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

export async function terminateCodeProcess(
  child: Pick<ChildProcess, "exitCode" | "signalCode" | "once">,
  signal: (signal: NodeJS.Signals) => void,
  gracefulTimeoutMs = PROCESS_STOP_TIMEOUT_MS,
  killTimeoutMs = PROCESS_KILL_TIMEOUT_MS,
): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observed = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return observed;
  };

  signal("SIGTERM");
  if (await waitForExit(gracefulTimeoutMs)) return;
  signal("SIGKILL");
  if (await waitForExit(killTimeoutMs)) return;
  throw new Error(
    `Cantrip Code did not exit within ${killTimeoutMs}ms after SIGKILL.`,
  );
}

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

export async function waitForAuthenticatedCodeHttp(
  child: Pick<ChildProcess, "exitCode" | "signalCode">,
  port: number,
  connectionToken: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatusCode: number | null = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        "Cantrip Code exited before its loopback server was ready.",
      );
    }
    const response = await new Promise<number | null>((resolve) => {
      let settled = false;
      const finish = (statusCode: number | null) => {
        if (settled) return;
        settled = true;
        resolve(statusCode);
      };
      const request = requestHttp(
        {
          host: "127.0.0.1",
          method: "GET",
          path: `/?tkn=${encodeURIComponent(connectionToken)}`,
          port,
        },
        (incoming) => {
          incoming.resume();
          finish(incoming.statusCode ?? null);
        },
      );
      request.setTimeout(
        Math.min(500, Math.max(1, deadline - Date.now())),
        () => {
          request.destroy();
          finish(null);
        },
      );
      request.once("error", () => finish(null));
      request.end();
    });
    if (response !== null) {
      lastStatusCode = response;
      if (response >= 200 && response < 400) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Cantrip Code did not return an authenticated HTTP response within ${timeoutMs}ms${lastStatusCode === null ? "." : ` (last status ${lastStatusCode}).`}`,
  );
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
  readonly #profileLifecycleOperations = new Map<string, Promise<void>>();
  readonly #profileOperations = new Map<string, Promise<ProfileProcess>>();
  readonly #profiles = new Map<string, ProfileProcess>();
  readonly #profileIdleTimeoutMs: number;
  readonly #profileLogWriter: (logPath: string, entry: string) => Promise<void>;
  readonly #readinessTimeoutMs: number;
  readonly #sessions = new Map<string, CodeSession>();
  readonly #sessionGenerations = new Map<string, number>();
  readonly #sessionOperations = new Map<string, Promise<void>>();
  readonly #workerId: string;
  readonly #workerName: string;
  #closed = false;
  #closeOperation: Promise<void> | null = null;
  #idleSweepTimer: ReturnType<typeof setInterval> | null = null;
  #stateOperation: Promise<void> = Promise.resolve();

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
    this.#profileLogWriter =
      options.profileLogWriter ??
      ((logPath, entry) => appendFile(logPath, entry, "utf8"));
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
    const generation = this.#sessionGeneration(command.sessionId);
    return this.#enqueueSessionOperation(command.sessionId, () =>
      this.#open(command, generation),
    );
  }

  /**
   * Starts the shared OpenVSCode process for a known profile without creating
   * a workspace or session. The caller must only provide a profile id after
   * its server/account binding has been authoritatively verified.
   *
   * A retained profile is deliberately bounded to one explicit profile id and
   * remains warm for the worker lifetime. The first real session still creates
   * and authorizes its own per-worktree workspace before it can be navigated.
   */
  async prewarmProfile(profileId: string): Promise<void> {
    this.#assertAvailable();
    if (this.#closed) {
      throw new Error("Cantrip Code supervisor is stopped.");
    }
    if (
      profileId.length === 0 ||
      profileId.length > 200 ||
      profileId.trim() !== profileId
    ) {
      throw new Error("Cantrip Code prewarm requires a valid profile id.");
    }
    const profileKey = stableKey(profileId);
    const existing = this.#profiles.get(profileKey);
    if (existing?.retainWarm) {
      if (
        existing.child &&
        existing.ready &&
        !existing.stopping &&
        existing.child.exitCode === null &&
        existing.child.signalCode === null
      ) {
        return;
      }
      if (existing.launchPromise) return existing.launchPromise;
    }

    return this.#enqueueProfileLifecycle(profileKey, async () => {
      if (this.#closed) {
        throw new Error("Cantrip Code supervisor is stopped.");
      }
      const profile = await this.#profile(profileId, profileKey);
      profile.retainWarm = true;
      profile.idleSinceMs = null;
      const now = Date.now();
      profile.crashTimes = profile.crashTimes.filter(
        (crash) => now - crash < CRASH_WINDOW_MS,
      );
      if (profile.crashTimes.length >= MAX_CRASHES_PER_WINDOW) {
        throw new Error(
          "Cantrip Code prewarm is paused after repeatedly crashing.",
        );
      }
      if (
        profile.child &&
        profile.ready &&
        !profile.stopping &&
        profile.child.exitCode === null &&
        profile.child.signalCode === null
      ) {
        return;
      }
      const startedAtMs = Date.now();
      workerLogger.event("info", "Cantrip Code profile prewarm requested", {
        event: "code.profile.prewarm-started",
        subsystem: "code",
        operation: "prewarm-profile",
        status: "started",
        profileKey,
      });
      try {
        await this.#ensureProfile(profile);
        if (this.#closed) {
          throw new Error("Cantrip Code supervisor stopped during prewarm.");
        }
        workerLogger.event("info", "Cantrip Code profile prewarm completed", {
          event: "code.profile.prewarm-ready",
          subsystem: "code",
          operation: "prewarm-profile",
          status: "completed",
          durationMs: Date.now() - startedAtMs,
          instanceId: profile.instanceId,
          profileKey,
        });
      } catch (error) {
        workerLogger.rateLimited(
          `code-profile-prewarm-failed:${profileKey}`,
          "warn",
          "Cantrip Code profile prewarm failed",
          {
            event: "code.profile.prewarm-failed",
            subsystem: "code",
            operation: "prewarm-profile",
            reasonCode: "profile-start-failed",
            status: "degraded",
            durationMs: Date.now() - startedAtMs,
            error: workerLogError(error),
            profileKey,
          },
        );
        throw error;
      }
    });
  }

  async #open(
    command: CodeOpenCommand,
    generation: number,
  ): Promise<CodeRuntimeStatus> {
    const startedAtMs = Date.now();
    this.#assertAvailable();
    this.#assertCurrentOperation(command.sessionId, generation);
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
    this.#assertCurrentOperation(command.sessionId, generation);
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
    this.#assertCurrentOperation(command.sessionId, generation);

    const current = this.#sessions.get(command.sessionId);
    if (current && !sameBinding(current, command, workspaceRootPath)) {
      await this.#retireSession(current);
    }
    let session = this.#sessions.get(command.sessionId);
    let bridgeRegistered = false;
    let createdSession: CodeSession | null = null;
    let createdSessionDirectory: string | null = null;
    try {
      if (!session) {
        const profileKey = stableKey(command.profileId);
        const sessionKey = stableKey(command.sessionId);
        const workspaceDirectory = path.join(
          this.#codeRoot,
          "workspaces",
          stableKey(command.projectId),
        );
        const sessionDirectory = path.join(
          this.#codeRoot,
          "sessions",
          sessionKey,
        );
        const sessionDirectoryExists = await stat(sessionDirectory)
          .then((entry) => entry.isDirectory())
          .catch(() => false);
        await Promise.all([
          mkdir(workspaceDirectory, { recursive: true }),
          mkdir(sessionDirectory, { recursive: true }),
        ]);
        if (!sessionDirectoryExists) createdSessionDirectory = sessionDirectory;
        this.#assertCurrentOperation(command.sessionId, generation);
        const bridgeToken = randomBytes(32).toString("hex");
        bridgeRegistered = true;
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
        session = {
          activeTunnelStreams: new Set(),
          activityRevision: 0,
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
        createdSession = session;
        await this.#attachProfile(session, generation);
        await this.#writeWorkspace(session);
        this.#assertCurrentOperation(command.sessionId, generation, session);
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

      session.appearance = command.appearance;
      if (initialFile) session.initialFile = initialFile;
      session.themeMode = "follow-cantrip";
      session.profileId = command.profileId;
      session.presentation = command.presentation;
      session.worktreeName = command.worktreeName ?? session.worktreeName;
      this.#touch(session);
      session.lastError = null;
      session.status = "starting";
      await this.#writeWorkspace(session);
      this.#assertCurrentOperation(command.sessionId, generation, session);
      await this.#ensureAttachedProfile(session, generation);
      this.#assertCurrentOperation(command.sessionId, generation, session);
      const startupAppearance = session.appearance;
      const startupSessionId = session.sessionId;
      void this.#bridge
        .setTheme(startupSessionId, startupAppearance)
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
              appearance: startupAppearance,
              error: workerLogError(error),
              sessionId: startupSessionId,
            },
          ),
        );
      session.status = "running";
      session.startedAt ??= isoNow();
      this.#touch(session);
      await this.#persistState();
      this.#assertCurrentOperation(command.sessionId, generation, session);
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
      let reportedError = error;
      if (createdSession || bridgeRegistered || createdSessionDirectory) {
        const rollbackFailures = await this.#rollbackOpen({
          bridgeRegistered,
          createdSession,
          createdSessionDirectory,
          sessionId: command.sessionId,
        });
        if (rollbackFailures.length > 0) {
          reportedError = new AggregateError(
            [error, ...rollbackFailures],
            "Cantrip Code session open failed and rollback was incomplete.",
            { cause: error },
          );
        }
      } else if (
        session &&
        this.#sessions.get(command.sessionId) === session &&
        this.#isCurrentOperation(command.sessionId, generation) &&
        !this.#closed
      ) {
        session.status = "failed";
        session.lastError =
          error instanceof Error ? error.message : String(error);
        this.#touch(session);
        await this.#persistState();
      }
      workerLogger.event("error", "Cantrip Code session failed to open", {
        event: "code.session.open-failed",
        subsystem: "code",
        operation: "open",
        reasonCode: "session-start-failed",
        status: "failed",
        codeTabId: command.codeTabId,
        durationMs: Date.now() - startedAtMs,
        error: workerLogError(reportedError),
        sessionId: command.sessionId,
      });
      throw reportedError;
    }
  }

  status(sessionId: string): CodeRuntimeStatus {
    const session = this.#requireSession(sessionId);
    const profile = this.#profiles.get(session.profileKey);
    if (!profile?.child && session.status === "running")
      session.status = "offline";
    this.#touch(session);
    return this.#status(session);
  }

  dirtyEditors(sessionId: string) {
    this.#touch(this.#requireSession(sessionId));
    return this.#bridge.dirtyEditors(sessionId);
  }

  async saveAll(sessionId: string): Promise<CodeSaveAllResult> {
    this.#touch(this.#requireSession(sessionId));
    return this.#bridge.saveAll(sessionId);
  }

  async openFile(
    sessionId: string,
    requestedPath: string,
  ): Promise<CodeOpenFileResult> {
    const generation = this.#sessionGeneration(sessionId);
    return this.#enqueueSessionOperation(sessionId, async () => {
      this.#assertCurrentOperation(sessionId, generation);
      const session = this.#requireSession(sessionId);
      const relativePath = await this.#authorizedRelativeFile(
        session.workspaceRootPath,
        requestedPath,
      );
      this.#assertCurrentOperation(sessionId, generation, session);
      session.initialFile = relativePath;
      this.#touch(session);
      await this.#writeWorkspace(session);
      this.#assertCurrentOperation(sessionId, generation, session);
      await this.#persistState();
      this.#assertCurrentOperation(sessionId, generation, session);
      const result = await this.#bridge.openFile(
        sessionId,
        relativePath,
        session.workspaceRootUri,
      );
      this.#assertCurrentOperation(sessionId, generation, session);
      return result;
    });
  }

  async setPresentation(
    sessionId: string,
    presentation: CodePresentation,
  ): Promise<CodeRuntimeStatus> {
    const generation = this.#sessionGeneration(sessionId);
    return this.#enqueueSessionOperation(sessionId, async () => {
      this.#assertCurrentOperation(sessionId, generation);
      const session = this.#requireSession(sessionId);
      session.presentation = presentation;
      this.#touch(session);
      await this.#writeWorkspace(session);
      this.#assertCurrentOperation(sessionId, generation, session);
      await this.#persistState();
      this.#assertCurrentOperation(sessionId, generation, session);
      await this.#bridge.setPresentation(sessionId, presentation);
      this.#assertCurrentOperation(sessionId, generation, session);
      return this.#status(session);
    });
  }

  async setTheme(
    sessionId: string,
    _themeMode: CodeThemeMode,
    appearance: CodeAppearance,
  ): Promise<CodeRuntimeStatus> {
    const generation = this.#sessionGeneration(sessionId);
    return this.#enqueueSessionOperation(sessionId, async () => {
      this.#assertCurrentOperation(sessionId, generation);
      const session = this.#requireSession(sessionId);
      session.themeMode = "follow-cantrip";
      session.appearance = appearance;
      this.#touch(session);
      workerLogger.event("debug", "Cantrip Code theme update requested", {
        event: "code.theme.updating",
        subsystem: "code",
        operation: "set-theme",
        status: "started",
        appearance,
        sessionId,
      });
      await this.#writeWorkspace(session);
      this.#assertCurrentOperation(sessionId, generation, session);
      await this.#bridge.setTheme(sessionId, appearance);
      this.#assertCurrentOperation(sessionId, generation, session);
      await this.#persistState();
      this.#assertCurrentOperation(sessionId, generation, session);
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
    });
  }

  async prepareAgentTurn(cwd: string): Promise<CodeAgentTurnPreparationResult> {
    const sessions = this.#sessionsForCwd(cwd);
    for (const session of sessions) this.#touch(session);
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
    for (const session of sessions) this.#touch(session);
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
    if (this.#closed) return this.#stoppedStatus(sessionId);
    this.#invalidateSession(sessionId);
    return this.#enqueueSessionOperation(sessionId, async () => {
      if (this.#closed) return this.#stoppedStatus(sessionId);
      const session = this.#sessions.get(sessionId);
      if (!session) return this.#stoppedStatus(sessionId);
      await this.#retireSession(session);
      return this.#stoppedStatus(sessionId);
    });
  }

  async #retireSession(session: CodeSession): Promise<void> {
    const sessionId = session.sessionId;
    if (this.#sessions.get(sessionId) !== session) return;
    session.status = "stopping";
    this.#touch(session);
    this.#bridge.unregister(sessionId);
    session.status = "stopped";
    this.#sessions.delete(sessionId);
    await Promise.all([
      this.#detachProfile(session),
      this.#persistState(),
      rm(session.workspacePath, { force: true }),
    ]);
  }

  proxyTarget(sessionId: string): CodeProxyTarget {
    const session = this.#requireSession(sessionId);
    this.#touch(session);
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
    this.#touch(session);
  }

  endTunnelStream(sessionId: string, streamId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.activeTunnelStreams.delete(streamId);
    this.#touch(session);
  }

  async evictIdleSessions(now = Date.now()): Promise<string[]> {
    if (this.#closed) return [];
    const candidates = [...this.#sessions.values()]
      .filter((session) => this.#isIdle(session, now))
      .map((session) => ({
        activityRevision: session.activityRevision,
        session,
      }));
    const evictionResults = await Promise.all(
      candidates.map(({ activityRevision, session }) =>
        this.#enqueueSessionOperation(session.sessionId, async () => {
          if (
            this.#closed ||
            this.#sessions.get(session.sessionId) !== session ||
            session.activityRevision !== activityRevision ||
            !this.#isIdle(session, now)
          ) {
            return false;
          }
          await this.#retireSession(session);
          return true;
        }),
      ),
    );
    const evicted = candidates.flatMap(({ session }, index) =>
      evictionResults[index] ? [session.sessionId] : [],
    );
    const idleProfiles = [...this.#profiles.values()].filter(
      (profile) =>
        !profile.retainWarm &&
        profile.sessions.size === 0 &&
        profile.idleSinceMs !== null &&
        now - profile.idleSinceMs >= this.#profileIdleTimeoutMs,
    );
    for (const profile of idleProfiles) {
      await this.#enqueueProfileLifecycle(profile.profileKey, async () => {
        if (
          this.#profiles.get(profile.profileKey) !== profile ||
          profile.sessions.size !== 0 ||
          profile.idleSinceMs === null ||
          now - profile.idleSinceMs < this.#profileIdleTimeoutMs
        ) {
          return;
        }
        await this.#terminateProfile(profile);
        if (profile.sessions.size === 0) {
          this.#profiles.delete(profile.profileKey);
        }
      });
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
    if (this.#closeOperation) return this.#closeOperation;
    this.#closed = true;
    for (const sessionId of this.#sessionGenerations.keys()) {
      this.#invalidateSession(sessionId);
    }
    for (const sessionId of this.#sessions.keys()) {
      this.#invalidateSession(sessionId);
    }
    if (this.#idleSweepTimer) {
      clearInterval(this.#idleSweepTimer);
      this.#idleSweepTimer = null;
    }
    this.#closeOperation = (async () => {
      await Promise.allSettled(this.#sessionOperations.values());
      this.#sessionOperations.clear();
      await Promise.allSettled(this.#profileLifecycleOperations.values());
      this.#profileLifecycleOperations.clear();
      await this.#stateOperation.catch(() => undefined);
      const now = isoNow();
      for (const session of this.#sessions.values()) {
        this.#bridge.unregister(session.sessionId);
        session.activeTunnelStreams.clear();
        session.status = "offline";
        session.lastActivityAt = now;
        session.activityRevision += 1;
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
      this.#sessionGenerations.clear();
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
    })();
    return this.#closeOperation;
  }

  async #enqueueSessionOperation<T>(
    sessionId: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#sessionOperations.get(sessionId);
    const operation = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(callback);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#sessionOperations.set(sessionId, tail);
    try {
      return await operation;
    } finally {
      if (this.#sessionOperations.get(sessionId) === tail) {
        this.#sessionOperations.delete(sessionId);
        if (!this.#sessions.has(sessionId)) {
          this.#sessionGenerations.delete(sessionId);
        }
      }
    }
  }

  async #enqueueProfileLifecycle<T>(
    profileKey: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#profileLifecycleOperations.get(profileKey);
    const operation = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(callback);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#profileLifecycleOperations.set(profileKey, tail);
    try {
      return await operation;
    } finally {
      if (this.#profileLifecycleOperations.get(profileKey) === tail) {
        this.#profileLifecycleOperations.delete(profileKey);
      }
    }
  }

  #sessionGeneration(sessionId: string): number {
    const generation = this.#sessionGenerations.get(sessionId) ?? 0;
    if (!this.#sessionGenerations.has(sessionId)) {
      this.#sessionGenerations.set(sessionId, generation);
    }
    return generation;
  }

  #invalidateSession(sessionId: string): void {
    this.#sessionGenerations.set(
      sessionId,
      this.#sessionGeneration(sessionId) + 1,
    );
  }

  #isCurrentOperation(sessionId: string, generation: number): boolean {
    return this.#sessionGeneration(sessionId) === generation;
  }

  #assertCurrentOperation(
    sessionId: string,
    generation: number,
    session?: CodeSession,
  ): void {
    if (this.#closed) {
      throw new Error("Cantrip Code supervisor is stopped.");
    }
    if (!this.#isCurrentOperation(sessionId, generation)) {
      throw new Error(
        `Cantrip Code session ${sessionId} was superseded by a newer lifecycle request.`,
      );
    }
    if (session && this.#sessions.get(sessionId) !== session) {
      throw new Error(
        `Cantrip Code session ${sessionId} was rebound during the operation.`,
      );
    }
  }

  #touch(session: CodeSession): void {
    session.lastActivityAt = isoNow();
    session.activityRevision += 1;
  }

  async #attachProfile(
    session: CodeSession,
    generation: number,
  ): Promise<ProfileProcess> {
    return this.#enqueueProfileLifecycle(session.profileKey, async () => {
      this.#assertCurrentOperation(session.sessionId, generation, session);
      const profile = await this.#profile(
        session.profileId,
        session.profileKey,
      );
      this.#assertCurrentOperation(session.sessionId, generation, session);
      profile.sessions.add(session.sessionId);
      profile.idleSinceMs = null;
      return profile;
    });
  }

  async #ensureAttachedProfile(
    session: CodeSession,
    generation: number,
  ): Promise<ProfileProcess> {
    return this.#enqueueProfileLifecycle(session.profileKey, async () => {
      this.#assertCurrentOperation(session.sessionId, generation, session);
      const profile = await this.#profile(
        session.profileId,
        session.profileKey,
      );
      this.#assertCurrentOperation(session.sessionId, generation, session);
      profile.sessions.add(session.sessionId);
      profile.idleSinceMs = null;
      await this.#ensureProfile(profile);
      this.#assertCurrentOperation(session.sessionId, generation, session);
      return profile;
    });
  }

  async #detachProfile(session: CodeSession): Promise<void> {
    await this.#enqueueProfileLifecycle(session.profileKey, async () => {
      const profile = this.#profiles.get(session.profileKey);
      profile?.sessions.delete(session.sessionId);
      if (profile?.sessions.size === 0) {
        if (profile.retainWarm) {
          profile.idleSinceMs = null;
        } else {
          profile.idleSinceMs = Date.now();
          if (profile.restartTimer) {
            clearTimeout(profile.restartTimer);
            profile.restartTimer = null;
          }
        }
      }
    });
  }

  async #rollbackOpen(input: {
    bridgeRegistered: boolean;
    createdSession: CodeSession | null;
    createdSessionDirectory: string | null;
    sessionId: string;
  }): Promise<unknown[]> {
    const {
      bridgeRegistered,
      createdSession,
      createdSessionDirectory,
      sessionId,
    } = input;
    if (
      createdSession &&
      this.#sessions.get(createdSession.sessionId) === createdSession
    ) {
      this.#sessions.delete(createdSession.sessionId);
    }
    if (bridgeRegistered) {
      this.#bridge.unregister(sessionId);
    }
    const cleanup = await Promise.allSettled([
      ...(createdSession
        ? [
            this.#detachProfile(createdSession),
            rm(createdSession.workspacePath, { force: true }),
          ]
        : []),
      ...(createdSessionDirectory
        ? [rm(createdSessionDirectory, { recursive: true, force: true })]
        : []),
      this.#persistState(),
    ]);
    return cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
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
        retainWarm: false,
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
    if (profile.launchPromise) return profile.launchPromise;
    profile.launchPromise = (async () => {
      const child = profile.child;
      const port = profile.port;
      const connectionToken = profile.connectionToken;
      if (child && port !== null && connectionToken && profile.ready) {
        try {
          await waitForAuthenticatedCodeHttp(
            child,
            port,
            connectionToken,
            this.#readinessTimeoutMs,
          );
          if (
            profile.child === child &&
            profile.port === port &&
            profile.connectionToken === connectionToken &&
            profile.ready &&
            !profile.stopping
          ) {
            return;
          }
          throw new Error("Cantrip Code process changed during health check.");
        } catch (error) {
          workerLogger.event(
            "warn",
            "Cantrip Code cached profile failed its functional health check",
            {
              event: "code.profile.health-failed",
              subsystem: "code",
              operation: "reuse-profile",
              reasonCode: "http-health-failed",
              status: "degraded",
              error: workerLogError(error),
              instanceId: profile.instanceId,
              profileKey: profile.profileKey,
            },
          );
          await this.#terminateProfile(profile);
        }
      }
      await this.#launchProfile(profile);
    })().finally(() => {
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
            this.#touch(session);
          }
        }
      }),
    );
    await this.#persistState();
  }

  async #launchProfile(profile: ProfileProcess): Promise<void> {
    const startedAtMs = Date.now();
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
      await waitForAuthenticatedCodeHttp(
        child,
        port,
        connectionToken,
        this.#readinessTimeoutMs,
      );
    } catch (error) {
      if (profile.child === child) {
        profile.stopping = true;
        try {
          await terminateCodeProcess(child, (signal) =>
            this.#signalProcessTree(child, signal),
          );
        } catch (terminationError) {
          throw new AggregateError(
            [error, terminationError],
            "Cantrip Code startup failed and its process could not be terminated.",
            { cause: error },
          );
        }
      }
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
      session.activityRevision += 1;
      session.lastError = null;
    }
    await this.#log(
      profile.logPath,
      `process ${instanceId} ready on loopback port ${port}`,
    );
    if (
      profile.child !== child ||
      !profile.ready ||
      profile.stopping ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      throw new Error("Cantrip Code exited while completing startup.");
    }
    workerLogger.event("info", "Cantrip Code profile process is ready", {
      event: "code.profile.ready",
      subsystem: "code",
      operation: "start-profile",
      status: "completed",
      durationMs: Date.now() - startedAtMs,
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
    if (intentional || (profile.sessions.size === 0 && !profile.retainWarm)) {
      return;
    }
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
      this.#touch(session);
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
      void this.#enqueueProfileLifecycle(profile.profileKey, async () => {
        if (
          this.#closed ||
          this.#profiles.get(profile.profileKey) !== profile ||
          (profile.sessions.size === 0 && !profile.retainWarm)
        ) {
          return;
        }
        try {
          await this.#ensureProfile(profile);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          for (const sessionId of profile.sessions) {
            const session = this.#sessions.get(sessionId);
            if (!session) continue;
            session.status = "failed";
            session.lastError = errorMessage;
          }
          await this.#persistState();
        }
      }).catch(() => undefined);
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
    await terminateCodeProcess(child, (signal) =>
      this.#signalProcessTree(child, signal),
    );
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
        "breadcrumbs.enabled": false,
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
        activityRevision: 0,
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
    await this.#profileLogWriter(logPath, `${isoNow()} ${message}\n`).catch(
      () => undefined,
    );
  }

  async #persistState(): Promise<void> {
    const operation = this.#stateOperation
      .catch(() => undefined)
      .then(() => this.#writeState());
    this.#stateOperation = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #writeState(): Promise<void> {
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
