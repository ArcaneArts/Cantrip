import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  RUN_CONFIGURATION_CANONICAL_PATH,
  workerRunSetupLookupSchema,
  workerRunSetupStatusSchema,
  type WorkerCommand,
  type WorkerRunSetupLookup,
  type WorkerRunSetupStatus,
  type WorktreeSetupJobError,
} from "@cantrip/protocol";
import * as pty from "node-pty";

import { workerLogError, workerLogger } from "./logger.js";
import { inspectRunConfigurationsForExecution } from "./run-configuration-discovery.js";
import { ensureSpawnHelperExecutable } from "./terminal-manager.js";
import { runShellInvocation } from "./managed-run-supervisor.js";

type RunSetupStart = Omit<
  Extract<WorkerCommand, { type: "project.run-setup.start" }>,
  "type"
>;

const MAX_OUTPUT_CHARS = 100_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_DELTA_ENTRIES = 256;
const MAX_DELTA_NAME_CHARS = 256;
const MAX_DELTA_VALUE_CHARS = 16 * 1024;
const MAX_DELTA_TOTAL_CHARS = 128 * 1024;
const TRANSIENT_ENVIRONMENT_NAMES = new Set(["_", "OLDPWD", "PWD", "SHLVL"]);

interface StoredRunSetup extends WorkerRunSetupStatus {
  sourcePath: string;
  worktreePath: string;
  environmentDelta: Record<string, string>;
}

interface ActiveRunSetup extends StoredRunSetup {
  process: pty.IPty | null;
  capturePath: string;
}

export interface RunSetupManagerOptions {
  authorize(input: RunSetupStart): Promise<{
    sourceRoot: string;
    worktreeRoot: string;
  }>;
  dataDirectory: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function stringEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function reservedEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    upper.startsWith("CANTRIP_") ||
    upper.startsWith("_CANTRIP_") ||
    upper === "CODEX_WORKTREE_PATH" ||
    TRANSIENT_ENVIRONMENT_NAMES.has(upper)
  );
}

function recordKey(
  projectId: string,
  worktreeId: string,
  revision: string | null,
): string {
  return createHash("sha256")
    .update(`${projectId}\0${worktreeId}\0${revision ?? "absent"}`)
    .digest("hex");
}

function statusOf(record: StoredRunSetup): WorkerRunSetupStatus {
  return workerRunSetupStatusSchema.parse({
    jobId: record.jobId,
    projectId: record.projectId,
    worktreeId: record.worktreeId,
    configurationRevision: record.configurationRevision,
    attempt: record.attempt,
    state: record.state,
    output: record.output,
    outputTruncated: record.outputTruncated,
    exitCode: record.exitCode,
    signal: record.signal,
    error: record.error,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    updatedAt: record.updatedAt,
  });
}

function setupError(
  code: WorktreeSetupJobError["code"],
  message: string,
  retryable: boolean,
): WorktreeSetupJobError {
  return {
    code,
    message: message.replace(/\s+/gu, " ").trim().slice(0, 2_000),
    retryable,
  };
}

function parsePosixEnvironment(contents: Buffer): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const entry of contents.toString("utf8").split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return environment;
}

function parseWindowsEnvironment(contents: Buffer): Record<string, string> {
  const value = JSON.parse(contents.toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PowerShell returned a malformed setup environment.");
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function boundedDelta(
  baseline: Record<string, string>,
  captured: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(captured).filter(
    ([name, value]) =>
      !reservedEnvironmentName(name) &&
      baseline[name] !== value &&
      name.length > 0 &&
      name.length <= MAX_DELTA_NAME_CHARS &&
      !name.includes("=") &&
      !name.includes("\0") &&
      value.length <= MAX_DELTA_VALUE_CHARS &&
      !value.includes("\0"),
  );
  if (entries.length > MAX_DELTA_ENTRIES) {
    throw new Error(
      `Setup exported more than ${MAX_DELTA_ENTRIES} environment variables.`,
    );
  }
  const total = entries.reduce(
    (size, [name, value]) => size + name.length + value.length,
    0,
  );
  if (total > MAX_DELTA_TOTAL_CHARS) {
    throw new Error("Setup environment exports exceed the protected limit.");
  }
  return Object.fromEntries(entries);
}

function wrapper(command: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return `$cantripExit = 0
$ErrorActionPreference = "Stop"
try {
  & {
${command}
  }
  if ($LASTEXITCODE -is [int]) { $cantripExit = $LASTEXITCODE }
  if ($cantripExit -eq 0) {
    $cantripEnvironment = @{}
    Get-ChildItem Env: | ForEach-Object { $cantripEnvironment[$_.Name] = $_.Value }
    $cantripJson = $cantripEnvironment | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($env:_CANTRIP_SETUP_ENV_FILE, $cantripJson, (New-Object System.Text.UTF8Encoding($false)))
  }
} catch {
  Write-Error $_
  $cantripExit = 1
}
exit $cantripExit`;
  }
  return `__cantrip_capture_environment() {
  __cantrip_status=$?
  trap - EXIT
  if [ "$__cantrip_status" -eq 0 ]; then
    env -0 > "$_CANTRIP_SETUP_ENV_FILE"
  fi
  exit "$__cantrip_status"
}
trap __cantrip_capture_environment EXIT
${command}`;
}

export class RunSetupManager {
  readonly #active = new Map<string, ActiveRunSetup>();
  readonly #authorize: RunSetupManagerOptions["authorize"];
  readonly #environment: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  readonly #recordsByJob = new Map<string, StoredRunSetup>();
  readonly #recordsByKey = new Map<string, StoredRunSetup>();
  readonly #root: string;
  #closing = false;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(options: RunSetupManagerOptions) {
    this.#authorize = options.authorize;
    this.#environment = options.environment ?? process.env;
    this.#platform = options.platform ?? process.platform;
    this.#root = path.resolve(options.dataDirectory, "run-setup");
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700);
    const entries = await readdir(this.#root, { withFileTypes: true });
    for (const entry of entries.slice(0, 2_000)) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".env") || entry.name.endsWith(".tmp")) {
        await rm(path.join(this.#root, entry.name), { force: true });
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(
          await readFile(path.join(this.#root, entry.name), "utf8"),
        ) as StoredRunSetup;
        const status = workerRunSetupStatusSchema.parse(parsed);
        const record: StoredRunSetup = {
          ...status,
          sourcePath: String(parsed.sourcePath),
          worktreePath: String(parsed.worktreePath),
          environmentDelta:
            parsed.environmentDelta &&
            typeof parsed.environmentDelta === "object" &&
            !Array.isArray(parsed.environmentDelta)
              ? boundedDelta({}, parsed.environmentDelta)
              : {},
        };
        if (record.state === "running") {
          record.state = "failed";
          record.completedAt = new Date().toISOString();
          record.updatedAt = record.completedAt;
          record.error = setupError(
            "setup-interrupted",
            "The worker restarted before setup completed.",
            true,
          );
          await this.#persist(record);
        }
        this.#remember(record);
      } catch {
        // Ignore malformed worker-private records rather than exposing them.
      }
    }
  }

  start(input: RunSetupStart): WorkerRunSetupStatus {
    const existing = this.#recordsByJob.get(input.jobId);
    if (
      existing &&
      existing.projectId === input.projectId &&
      existing.worktreeId === input.worktreeId &&
      existing.configurationRevision === input.configurationRevision &&
      existing.attempt === input.attempt
    ) {
      return statusOf(existing);
    }
    const active = this.#active.get(input.jobId);
    if (active?.process) {
      if (
        active.projectId !== input.projectId ||
        active.worktreeId !== input.worktreeId ||
        active.configurationRevision !== input.configurationRevision
      ) {
        throw new Error("The setup job is already running for another target.");
      }
      active.attempt = input.attempt;
      active.updatedAt = new Date().toISOString();
      void this.#persist(active);
      return statusOf(active);
    }
    if (this.#closing) throw new Error("The setup manager is shutting down.");

    const now = new Date().toISOString();
    const capturePath = path.join(
      this.#root,
      `${recordKey(input.projectId, input.worktreeId, input.configurationRevision)}.${input.attempt}.env`,
    );
    const session: ActiveRunSetup = {
      jobId: input.jobId,
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      configurationRevision: input.configurationRevision,
      attempt: input.attempt,
      state: "running",
      output: "",
      outputTruncated: false,
      exitCode: null,
      signal: null,
      error: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      sourcePath: input.sourcePath,
      worktreePath: input.worktreePath,
      environmentDelta: {},
      capturePath,
      process: null,
    };
    this.#active.set(input.jobId, session);
    this.#remember(session);
    void this.#persist(session);
    void this.#launch(input, session);
    return statusOf(session);
  }

  status(
    jobId: string,
    projectId: string,
    worktreeId: string,
  ): WorkerRunSetupLookup {
    const record = this.#recordsByJob.get(jobId);
    if (
      !record ||
      record.projectId !== projectId ||
      record.worktreeId !== worktreeId
    ) {
      return workerRunSetupLookupSchema.parse({ found: false, jobId });
    }
    return workerRunSetupLookupSchema.parse({
      found: true,
      status: statusOf(record),
    });
  }

  environmentFor(
    projectId: string,
    worktreeId: string,
    revision: string,
  ): Record<string, string> {
    const record = this.#recordsByKey.get(
      recordKey(projectId, worktreeId, revision),
    );
    return record?.state === "succeeded" ? { ...record.environmentDelta } : {};
  }

  environmentForPath(worktreePath: string): Record<string, string> {
    const resolved = path.resolve(worktreePath);
    const candidates = [...this.#recordsByKey.values()]
      .filter(
        (record) =>
          record.state === "succeeded" &&
          path.resolve(record.worktreePath) === resolved,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { ...(candidates[0]?.environmentDelta ?? {}) };
  }

  async removeForPath(worktreePath: string): Promise<void> {
    const resolved = path.resolve(worktreePath);
    const matches = [...this.#recordsByKey.values()].filter(
      (record) => path.resolve(record.worktreePath) === resolved,
    );
    for (const record of matches) {
      const active = this.#active.get(record.jobId);
      if (active?.process) active.process.kill();
      if (active) await rm(active.capturePath, { force: true });
      this.#active.delete(record.jobId);
      this.#recordsByJob.delete(record.jobId);
      this.#recordsByKey.delete(
        recordKey(
          record.projectId,
          record.worktreeId,
          record.configurationRevision,
        ),
      );
      await rm(this.#recordPath(record), { force: true });
    }
  }

  async reconcile(
    sourcePath: string,
    existingWorktreePaths: string[],
  ): Promise<void> {
    const canonicalSource = path.resolve(sourcePath);
    const existing = new Set(
      existingWorktreePaths.map((item) => path.resolve(item)),
    );
    const missing = [...this.#recordsByKey.values()].filter(
      (record) =>
        path.resolve(record.sourcePath) === canonicalSource &&
        !existing.has(path.resolve(record.worktreePath)),
    );
    for (const record of missing) await this.removeForPath(record.worktreePath);
  }

  async closeAll(): Promise<void> {
    this.#closing = true;
    for (const session of this.#active.values()) {
      if (!session.process) continue;
      session.error = setupError(
        "setup-interrupted",
        "The worker stopped before setup completed.",
        true,
      );
      session.state = "failed";
      session.completedAt = new Date().toISOString();
      session.updatedAt = session.completedAt;
      session.process.kill();
      session.process = null;
      await rm(session.capturePath, { force: true });
      await this.#persist(session);
    }
    this.#active.clear();
    await this.#writeQueue;
  }

  async #launch(input: RunSetupStart, session: ActiveRunSetup): Promise<void> {
    try {
      const roots = await this.#authorize(input);
      session.sourcePath = roots.sourceRoot;
      session.worktreePath = roots.worktreeRoot;
      const inspection = await inspectRunConfigurationsForExecution(
        roots.sourceRoot,
        this.#platform,
      );
      const configuration = inspection.configurations.find(
        ({ relativePath }) => relativePath === RUN_CONFIGURATION_CANONICAL_PATH,
      );
      const currentRevision = configuration?.revision ?? null;
      if (currentRevision !== input.configurationRevision) {
        await this.#finishWithoutProcess(
          session,
          setupError(
            "configuration-stale",
            "The project environment changed before setup could start.",
            true,
          ),
        );
        return;
      }
      if (!inspection.valid) {
        await this.#finishWithoutProcess(
          session,
          setupError(
            "configuration-invalid",
            "The project environment is invalid. Validate it before retrying setup.",
            true,
          ),
        );
        return;
      }
      if (!configuration?.setup) {
        session.output =
          "No platform-compatible setup script is configured.\r\n";
        session.environmentDelta = {};
        await this.#removeOtherRevisions(session);
        await this.#finishWithoutProcess(session, null);
        return;
      }

      await writeFile(session.capturePath, "", { mode: 0o600 });
      await chmod(session.capturePath, 0o600);
      const baseline = {
        ...stringEnvironment(process.env),
        ...stringEnvironment(this.#environment),
        CODEX_WORKTREE_PATH: roots.worktreeRoot,
        CANTRIP_WORKTREE_PATH: roots.worktreeRoot,
        CANTRIP_PROJECT_ROOT: roots.sourceRoot,
        _CANTRIP_SETUP_ENV_FILE: session.capturePath,
      };
      const script = wrapper(configuration.setup.command, this.#platform);
      const launch = runShellInvocation(script, this.#platform, baseline);
      ensureSpawnHelperExecutable();
      const child = pty.spawn(launch.command, launch.args, {
        cols: 120,
        rows: 40,
        cwd: roots.worktreeRoot,
        env: baseline,
        name: "xterm-256color",
      });
      session.process = child;
      child.onData((data) => {
        if (session.process !== child) return;
        const combined = `${session.output}${data}`;
        session.outputTruncated =
          session.outputTruncated || combined.length > MAX_OUTPUT_CHARS;
        session.output = combined.slice(-MAX_OUTPUT_CHARS);
        session.updatedAt = new Date().toISOString();
      });
      child.onExit(({ exitCode, signal }) => {
        if (session.process !== child) return;
        session.process = null;
        void this.#finishProcess(session, baseline, exitCode, signal).catch(
          (error: unknown) => {
            void this.#finishWithoutProcess(
              session,
              setupError(
                "setup-failed",
                error instanceof Error
                  ? error.message
                  : "Setup completion could not be recorded.",
                true,
              ),
            );
          },
        );
      });
      workerLogger.event("info", "Worktree setup process started", {
        event: "run.setup.started",
        subsystem: "run-setup",
        operation: "setup",
        status: "running",
        runId: input.jobId,
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        attempt: input.attempt,
      });
    } catch (error) {
      workerLogger.event("error", "Worktree setup failed to start", {
        event: "run.setup.start-failed",
        subsystem: "run-setup",
        operation: "setup",
        reasonCode: "start-failed",
        status: "failed",
        runId: input.jobId,
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        error: workerLogError(error),
      });
      await rm(session.capturePath, { force: true });
      await this.#finishWithoutProcess(
        session,
        setupError(
          "setup-start-failed",
          error instanceof Error ? error.message : "Setup could not start.",
          true,
        ),
      );
    }
  }

  async #finishProcess(
    session: ActiveRunSetup,
    baseline: Record<string, string>,
    exitCode: number,
    signal: number | undefined,
  ): Promise<void> {
    try {
      session.exitCode = exitCode;
      session.signal = signal ? String(signal) : null;
      if (exitCode === 0) {
        const metadata = await stat(session.capturePath);
        if (metadata.size > MAX_CAPTURE_BYTES) {
          throw new Error("Setup environment capture exceeded its size limit.");
        }
        const contents = await readFile(session.capturePath);
        const captured =
          this.#platform === "win32"
            ? parseWindowsEnvironment(contents)
            : parsePosixEnvironment(contents);
        session.environmentDelta = boundedDelta(baseline, captured);
        await this.#removeOtherRevisions(session);
        await this.#finishWithoutProcess(session, null);
      } else {
        await this.#finishWithoutProcess(
          session,
          setupError(
            "setup-failed",
            `Setup exited with code ${exitCode}${session.signal ? ` (${session.signal})` : ""}.`,
            true,
          ),
        );
      }
    } finally {
      await rm(session.capturePath, { force: true });
    }
  }

  async #finishWithoutProcess(
    session: ActiveRunSetup,
    error: WorktreeSetupJobError | null,
  ): Promise<void> {
    session.process = null;
    session.state = error ? "failed" : "succeeded";
    session.error = error;
    session.completedAt = new Date().toISOString();
    session.updatedAt = session.completedAt;
    this.#active.delete(session.jobId);
    this.#remember(session);
    await this.#persist(session);
    workerLogger.event(
      error ? "warn" : "info",
      error ? "Worktree setup failed" : "Worktree setup completed",
      {
        event: error ? "run.setup.failed" : "run.setup.completed",
        subsystem: "run-setup",
        operation: "setup",
        reasonCode: error?.code,
        status: session.state,
        runId: session.jobId,
        projectId: session.projectId,
        worktreeId: session.worktreeId,
        attempt: session.attempt,
        exitCode: session.exitCode,
      },
    );
  }

  #remember(record: StoredRunSetup): void {
    this.#recordsByJob.set(record.jobId, record);
    this.#recordsByKey.set(
      recordKey(
        record.projectId,
        record.worktreeId,
        record.configurationRevision,
      ),
      record,
    );
  }

  #recordPath(record: StoredRunSetup): string {
    return path.join(
      this.#root,
      `${recordKey(record.projectId, record.worktreeId, record.configurationRevision)}.json`,
    );
  }

  async #removeOtherRevisions(record: StoredRunSetup): Promise<void> {
    const others = [...this.#recordsByKey.values()].filter(
      (candidate) =>
        candidate.projectId === record.projectId &&
        candidate.worktreeId === record.worktreeId &&
        candidate.configurationRevision !== record.configurationRevision,
    );
    for (const candidate of others) {
      this.#recordsByKey.delete(
        recordKey(
          candidate.projectId,
          candidate.worktreeId,
          candidate.configurationRevision,
        ),
      );
      if (candidate.jobId !== record.jobId) {
        this.#recordsByJob.delete(candidate.jobId);
      }
      await rm(this.#recordPath(candidate), { force: true });
    }
  }

  async #persist(record: StoredRunSetup): Promise<void> {
    const pathname = this.#recordPath(record);
    const temporary = `${pathname}.${process.pid}.tmp`;
    const contents = `${JSON.stringify({
      ...statusOf(record),
      sourcePath: record.sourcePath,
      worktreePath: record.worktreePath,
      environmentDelta: record.environmentDelta,
    })}\n`;
    const write = async () => {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      await writeFile(temporary, contents, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, pathname);
      await chmod(pathname, 0o600);
    };
    this.#writeQueue = this.#writeQueue.then(write, write);
    await this.#writeQueue;
  }
}
