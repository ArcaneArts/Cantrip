import { realpath } from "node:fs/promises";
import path from "node:path";

import type {
  RunConfigurationEnvironment,
  RunConfigurationFile,
  RunConfigurationPlatform,
} from "@cantrip/protocol/run-configuration-definitions";
import {
  RUN_CONFIGURATION_RUNTIME_LIST_LIMIT,
  runConfigurationRuntimeWorkerLookupSchema,
  runConfigurationRuntimeWorkerObservationSchema,
  runConfigurationRuntimeWorkerOperationResultSchema,
  runConfigurationRuntimeWorkerOutputSchema,
  runConfigurationRuntimeWorkerReconciliationSchema,
  type RunConfigurationRuntimeLaunchIdentity,
  type RunConfigurationRuntimeWorkerCommand,
  type RunConfigurationRuntimeWorkerIdentity,
  type RunConfigurationRuntimeWorkerLookup,
  type RunConfigurationRuntimeWorkerObservation,
  type RunConfigurationRuntimeWorkerOperationResult,
  type RunConfigurationRuntimeWorkerOutput,
  type RunConfigurationRuntimeWorkerReconciliation,
} from "@cantrip/protocol/run-configuration-runtime";
import type { RunConfigurationProtectedSecret } from "@cantrip/protocol/run-configuration-secrets";
import * as pty from "node-pty";

import { workerLogger } from "./logger.js";
import { dartRunConfigurationProvider } from "./run-configuration-dart-provider.js";
import { flutterRunConfigurationProvider } from "./run-configuration-flutter-provider.js";
import { rustRunConfigurationProvider } from "./run-configuration-rust-provider.js";
import { nodeRunConfigurationProvider } from "./run-configuration-node-provider.js";
import { javaRunConfigurationProvider } from "./run-configuration-java-provider.js";
import {
  findRunConfigurationExecutable,
  shellRunConfigurationProvider,
  type MaterializedRunCommand,
  type RunConfigurationProviderContext,
} from "./run-configuration-provider.js";
import { RunConfigurationRepository } from "./run-configuration-repository.js";
import { RunConfigurationProcessTreeController } from "./run-configuration-process-tree.js";
import { ensureSpawnHelperExecutable } from "./terminal-manager.js";
import {
  RunConfigurationEnvironmentResolutionError,
  type RunConfigurationEnvironmentExecutionResult,
} from "./run-configuration-environment-source.js";
import { runConfigurationEnvironmentNameIsReserved } from "./run-configuration-environment-policy.js";

const MAX_RETAINED_RUNTIMES = RUN_CONFIGURATION_RUNTIME_LIST_LIMIT;
const MAX_SCROLLBACK_CHARS = 256 * 1_024;
const FORCE_EXIT_WAIT_MS = 1_000;
const MAX_ENVIRONMENT_LAYER_ENTRIES = 256;
const MAX_ENVIRONMENT_LAYER_VALUE_CHARS = 16 * 1024;
const MAX_ENVIRONMENT_LAYER_TOTAL_CHARS = 128 * 1024;

type StartCommand = Extract<
  RunConfigurationRuntimeWorkerCommand,
  { type: "project.run-configuration-runtime.start" }
>;
type RestartCommand = Extract<
  RunConfigurationRuntimeWorkerCommand,
  { type: "project.run-configuration-runtime.restart" }
>;
type StopCommand = Extract<
  RunConfigurationRuntimeWorkerCommand,
  { type: "project.run-configuration-runtime.stop" }
>;
type OutputCommand = Extract<
  RunConfigurationRuntimeWorkerCommand,
  { type: "project.run-configuration-runtime.output" }
>;
type RuntimeOutputRequest = Omit<OutputCommand, "serverId"> & {
  serverId?: string;
};
type LaunchCommand = StartCommand | RestartCommand;

export interface AuthorizedRunConfigurationRoots {
  sourceRoot: string;
  targetRoot: string;
}

export interface RunConfigurationEnvironmentLayers {
  codex?: Record<string, string>;
  codexEnvironmentRevision?: string | null;
  files?: Record<string, string>;
  secrets?: Record<string, string>;
}

export interface RunConfigurationRuntimeEnvironmentInput {
  baseline: Record<string, string>;
  defaultShell: string | null;
  document: RunConfigurationFile;
  environment: RunConfigurationEnvironment;
  identity: RunConfigurationRuntimeLaunchIdentity;
  platform: RunConfigurationPlatform;
  protectedSecrets: RunConfigurationProtectedSecret[];
  sourceRoot: string;
  targetRoot: string;
  execute(
    command: MaterializedRunCommand,
    environment: Record<string, string>,
    timeoutMs: number,
  ): Promise<RunConfigurationEnvironmentExecutionResult>;
}

export interface RunConfigurationRuntimeSupervisorOptions {
  authorize(input: LaunchCommand): Promise<AuthorizedRunConfigurationRoots>;
  environment?: NodeJS.ProcessEnv;
  notify?(observation: RunConfigurationRuntimeWorkerObservation): void;
  platform?: NodeJS.Platform;
  resolveEnvironment?(
    input: RunConfigurationRuntimeEnvironmentInput,
  ): Promise<RunConfigurationEnvironmentLayers>;
}

interface TrackedProcess {
  child: pty.IPty;
  exit: Promise<ProcessExit>;
  generation: number;
  operationId: string;
  phase: "before-launch" | "runtime";
}

interface ProcessExit {
  exitCode: number;
  signal: string | null;
}

interface RuntimeSession extends RunConfigurationRuntimeLaunchIdentity {
  buffer: string;
  endedAt: string | null;
  exitCode: number | null;
  failure: RunConfigurationRuntimeWorkerObservation["failure"];
  launchTask: Promise<void> | null;
  process: TrackedProcess | null;
  requestedRootKind: LaunchCommand["rootKind"];
  requestedSourcePath: string;
  requestedTargetPath: string;
  signal: string | null;
  sourceRoot: string | null;
  startedAt: string | null;
  state: RunConfigurationRuntimeWorkerObservation["state"];
  stopGracePeriodMs: number;
  targetRoot: string | null;
}

class RuntimeLaunchError extends Error {
  readonly code: string;
  readonly phase: NonNullable<
    RunConfigurationRuntimeWorkerObservation["failure"]
  >["phase"];
  readonly retryable: boolean;

  constructor(
    phase: RuntimeLaunchError["phase"],
    code: string,
    message: string,
    retryable: boolean,
  ) {
    super(message);
    this.name = "RuntimeLaunchError";
    this.phase = phase;
    this.code = code;
    this.retryable = retryable;
  }
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

function enabledVariables(
  environment: RunConfigurationEnvironment,
): Record<string, string> {
  return Object.fromEntries(
    environment.variables
      .filter(({ enabled }) => enabled)
      .map(({ name, value }) => [name, value]),
  );
}

function boundedEnvironmentLayer(
  layer: Record<string, string> | undefined,
): Record<string, string> {
  if (!layer) return {};
  const entries = Object.entries(layer);
  if (entries.length > MAX_ENVIRONMENT_LAYER_ENTRIES) {
    throw new RuntimeLaunchError(
      "environment",
      "environment-layer-too-large",
      "An environment source exported too many variables.",
      false,
    );
  }
  let total = 0;
  for (const [name, value] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      name.length > 256 ||
      name.includes("\0") ||
      value.length > MAX_ENVIRONMENT_LAYER_VALUE_CHARS ||
      value.includes("\0")
    ) {
      throw new RuntimeLaunchError(
        "environment",
        "environment-layer-invalid",
        "An environment source exported an invalid variable.",
        false,
      );
    }
    total += name.length + value.length;
  }
  if (total > MAX_ENVIRONMENT_LAYER_TOTAL_CHARS) {
    throw new RuntimeLaunchError(
      "environment",
      "environment-layer-too-large",
      "An environment source exceeded the bounded variable size.",
      false,
    );
  }
  return Object.fromEntries(
    entries.filter(
      ([name]) => !runConfigurationEnvironmentNameIsReserved(name),
    ),
  );
}

function reservedEnvironment(
  session: RuntimeSession,
  sourceRoot: string,
  targetRoot: string,
): Record<string, string> {
  return {
    CANTRIP_PROJECT_ID: session.projectId,
    CANTRIP_PROJECT_ROOT: sourceRoot,
    CANTRIP_RUN_CONFIGURATION_ID: session.configurationId,
    CANTRIP_RUN_GENERATION: String(session.generation),
    CANTRIP_RUN_OPERATION_ID: session.operationId,
    CANTRIP_RUN_RUNTIME_ID: session.runtimeId,
    CANTRIP_RUN_TERMINAL_ID: session.terminalId,
    CANTRIP_RUN_WORKTREE_ID: session.worktreeId,
    CANTRIP_WORKTREE_PATH: targetRoot,
    CODEX_WORKTREE_PATH: targetRoot,
  };
}

function protectedBaselineEnvironment(
  environment: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) =>
      runConfigurationEnvironmentNameIsReserved(name),
    ),
  );
}

function platformForProvider(
  platform: NodeJS.Platform,
): RunConfigurationPlatform {
  if (platform === "win32" || platform === "darwin" || platform === "linux") {
    return platform;
  }
  throw new RuntimeLaunchError(
    "provider",
    "platform-unsupported",
    `Run configurations are unavailable on ${platform}.`,
    false,
  );
}

async function validateRunConfigurationProvider(
  document: RunConfigurationFile,
  context: RunConfigurationProviderContext,
) {
  switch (document.provider) {
    case "shell":
      return shellRunConfigurationProvider.validate(document, context);
    case "node":
      return nodeRunConfigurationProvider.validate(document, context);
    case "java":
      return javaRunConfigurationProvider.validate(document, context);
    case "dart":
      return dartRunConfigurationProvider.validate(document, context);
    case "flutter":
      return flutterRunConfigurationProvider.validate(document, context);
    case "rust":
      return rustRunConfigurationProvider.validate(document, context);
  }
}

function stableIdentityMatches(
  session: RuntimeSession,
  identity: RunConfigurationRuntimeWorkerIdentity,
): boolean {
  return (
    session.runtimeId === identity.runtimeId &&
    session.projectId === identity.projectId &&
    session.configurationId === identity.configurationId &&
    session.worktreeId === identity.worktreeId &&
    session.workerId === identity.workerId &&
    session.terminalId === identity.terminalId
  );
}

function generationIdentityMatches(
  session: RuntimeSession,
  identity: RunConfigurationRuntimeWorkerIdentity,
): boolean {
  return (
    stableIdentityMatches(session, identity) &&
    session.definitionRevision === identity.definitionRevision &&
    session.codexEnvironmentRevision === identity.codexEnvironmentRevision &&
    session.generation === identity.generation &&
    session.operationId === identity.operationId
  );
}

function generationLaunchIsCurrent(
  session: RuntimeSession,
  identity: RunConfigurationRuntimeWorkerIdentity,
): boolean {
  return (
    generationIdentityMatches(session, identity) &&
    (session.state === "starting" || session.state === "restarting")
  );
}

function launchRequestMatches(
  session: RuntimeSession,
  command: LaunchCommand,
): boolean {
  return (
    generationIdentityMatches(session, command.identity) &&
    session.requestedRootKind === command.rootKind &&
    session.requestedSourcePath === command.sourcePath &&
    session.requestedTargetPath === command.targetPath
  );
}

function activeState(
  state: RunConfigurationRuntimeWorkerObservation["state"],
): boolean {
  return ["starting", "running", "restarting", "stopping"].includes(state);
}

function boundedFailure(
  error: unknown,
): NonNullable<RunConfigurationRuntimeWorkerObservation["failure"]> {
  const launchError =
    error instanceof RuntimeLaunchError
      ? error
      : new RuntimeLaunchError(
          "spawn",
          "launch-failed",
          "The Run could not start.",
          true,
        );
  const message = launchError.message.replace(/\s+/gu, " ").trim();
  return {
    phase: launchError.phase,
    code: launchError.code.slice(0, 100) || "launch-failed",
    message: message.slice(0, 1_000) || "The Run could not start.",
    retryable: launchError.retryable,
  };
}

function pathIsAtOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function processSignal(signal: number | undefined): string | null {
  return signal ? String(signal) : null;
}

export class RunConfigurationRuntimeSupervisor {
  readonly #authorize: RunConfigurationRuntimeSupervisorOptions["authorize"];
  readonly #environment: NodeJS.ProcessEnv;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #notify: NonNullable<
    RunConfigurationRuntimeSupervisorOptions["notify"]
  >;
  readonly #platform: NodeJS.Platform;
  readonly #processTree: RunConfigurationProcessTreeController;
  readonly #resolveEnvironment: NonNullable<
    RunConfigurationRuntimeSupervisorOptions["resolveEnvironment"]
  >;
  readonly #runtimes = new Map<string, RuntimeSession>();
  #closing = false;

  constructor(options: RunConfigurationRuntimeSupervisorOptions) {
    this.#authorize = options.authorize;
    this.#environment = options.environment ?? process.env;
    this.#notify = options.notify ?? (() => undefined);
    this.#platform = options.platform ?? process.platform;
    this.#processTree = new RunConfigurationProcessTreeController({
      platform: this.#platform,
    });
    this.#resolveEnvironment =
      options.resolveEnvironment ??
      (async ({ environment }) => {
        if (environment.files.length > 0) {
          throw new RuntimeLaunchError(
            "environment",
            "environment-files-unavailable",
            "Environment file resolution is not available for this Run.",
            true,
          );
        }
        const missing = environment.secrets.filter(({ enabled }) => enabled);
        if (missing.length > 0) {
          throw new RuntimeLaunchError(
            "environment",
            "secret-reference-unavailable",
            `Secret reference ${missing[0]!.secret} is unavailable.`,
            true,
          );
        }
        return {};
      });
  }

  ownsTerminal(terminalId: string): boolean {
    return [...this.#runtimes.values()].some(
      (session) => session.terminalId === terminalId,
    );
  }

  async start(
    command: StartCommand,
  ): Promise<RunConfigurationRuntimeWorkerOperationResult> {
    return this.#withLock(command.identity.runtimeId, async () => {
      if (this.#closing) {
        throw new Error("The Run configuration supervisor is shutting down.");
      }
      const existing = this.#runtimes.get(command.identity.runtimeId);
      if (existing) {
        this.#assertStableIdentity(existing, command.identity);
        if (launchRequestMatches(existing, command)) {
          return this.#operationResult("replayed", existing);
        }
        if (command.identity.generation <= existing.generation) {
          return this.#operationResult("stale", existing);
        }
        if (activeState(existing.state)) {
          throw new Error(
            "A start cannot replace an active Run configuration generation.",
          );
        }
        this.#beginGeneration(existing, command, "starting");
        this.#appendDivider(existing, "Starting next generation");
        this.#launch(existing, command);
        return this.#operationResult("accepted", existing);
      }

      this.#evictCompleted();
      if (this.#runtimes.size >= MAX_RETAINED_RUNTIMES) {
        throw new Error(
          "This worker is retaining the maximum number of Run configuration runtimes.",
        );
      }
      const session: RuntimeSession = {
        ...command.identity,
        buffer: "",
        endedAt: null,
        exitCode: null,
        failure: null,
        launchTask: null,
        process: null,
        requestedRootKind: command.rootKind,
        requestedSourcePath: command.sourcePath,
        requestedTargetPath: command.targetPath,
        signal: null,
        sourceRoot: null,
        startedAt: null,
        state: "starting",
        stopGracePeriodMs: 3_000,
        targetRoot: null,
      };
      this.#runtimes.set(session.runtimeId, session);
      this.#emit(session);
      this.#launch(session, command);
      return this.#operationResult("accepted", session);
    });
  }

  async restart(
    command: RestartCommand,
  ): Promise<RunConfigurationRuntimeWorkerOperationResult> {
    return this.#withLock(command.identity.runtimeId, async () => {
      const session = this.#runtimes.get(command.identity.runtimeId);
      if (!session) return this.#operationResult("not-found", null);
      this.#assertStableIdentity(session, command.identity);
      const replayingInterruptedRestart =
        launchRequestMatches(session, command) &&
        session.state === "restarting";
      if (
        launchRequestMatches(session, command) &&
        !replayingInterruptedRestart
      ) {
        return this.#operationResult("replayed", session);
      }
      if (
        !replayingInterruptedRestart &&
        command.identity.generation <= session.generation
      ) {
        return this.#operationResult("stale", session);
      }
      if (
        !replayingInterruptedRestart &&
        (!activeState(session.state) ||
          command.identity.generation !== session.generation + 1)
      ) {
        throw new Error(
          "A restart must advance one active Run configuration generation.",
        );
      }

      const previous = session.process;
      if (!replayingInterruptedRestart) {
        this.#beginGeneration(session, command, "restarting");
      }
      if (previous) await this.#terminateTracked(previous, 0, true);
      if (!generationIdentityMatches(session, command.identity)) {
        return this.#operationResult("stale", session);
      }
      this.#appendDivider(session, "Restarting");
      session.state = "starting";
      this.#emit(session);
      this.#launch(session, command);
      return this.#operationResult(
        replayingInterruptedRestart ? "replayed" : "accepted",
        session,
      );
    });
  }

  async stop(
    command: StopCommand,
  ): Promise<RunConfigurationRuntimeWorkerOperationResult> {
    return this.#withLock(command.identity.runtimeId, async () => {
      const session = this.#runtimes.get(command.identity.runtimeId);
      if (!session) return this.#operationResult("not-found", null);
      this.#assertStableIdentity(session, command.identity);
      const replayingInterruptedStop =
        generationIdentityMatches(session, command.identity) &&
        session.state === "stopping";
      if (
        generationIdentityMatches(session, command.identity) &&
        !replayingInterruptedStop
      ) {
        return this.#operationResult("replayed", session);
      }
      if (command.identity.generation < session.generation) {
        return this.#operationResult("stale", session);
      }
      if (
        command.identity.generation > session.generation ||
        command.identity.definitionRevision !== session.definitionRevision ||
        command.identity.codexEnvironmentRevision !==
          session.codexEnvironmentRevision
      ) {
        throw new Error(
          "The stop target does not match the active generation.",
        );
      }
      if (!activeState(session.state)) {
        return this.#operationResult("replayed", session);
      }

      if (!replayingInterruptedStop) {
        session.operationId = command.identity.operationId;
        session.state = "stopping";
        session.failure = null;
        this.#emit(session);
      }
      const tracked = session.process;
      const result = tracked
        ? await this.#terminateTracked(
            tracked,
            session.stopGracePeriodMs,
            false,
          )
        : null;
      if (session.operationId !== command.identity.operationId) {
        return this.#operationResult("stale", session);
      }
      session.process = null;
      session.state = "idle";
      session.endedAt = new Date().toISOString();
      session.exitCode = result?.exitCode ?? session.exitCode;
      session.signal = result?.signal ?? session.signal;
      this.#emit(session);
      return this.#operationResult(
        replayingInterruptedStop ? "replayed" : "accepted",
        session,
      );
    });
  }

  status(
    identity: RunConfigurationRuntimeWorkerIdentity,
  ): RunConfigurationRuntimeWorkerLookup {
    const session = this.#runtimes.get(identity.runtimeId);
    if (!session || !generationIdentityMatches(session, identity)) {
      return runConfigurationRuntimeWorkerLookupSchema.parse({
        found: false,
        identity,
      });
    }
    return runConfigurationRuntimeWorkerLookupSchema.parse({
      found: true,
      observation: this.#observation(session),
    });
  }

  output(command: RuntimeOutputRequest): RunConfigurationRuntimeWorkerOutput {
    const session = this.#runtimes.get(command.identity.runtimeId);
    if (!session || !generationIdentityMatches(session, command.identity)) {
      throw new Error(
        "The Run configuration output is not available on this worker.",
      );
    }
    const data = session.buffer.slice(-command.tail);
    return runConfigurationRuntimeWorkerOutputSchema.parse({
      requestOperationId: command.requestOperationId,
      identity: command.identity,
      data,
      truncated: session.buffer.length > data.length,
    });
  }

  async reconcile(
    identities: RunConfigurationRuntimeWorkerIdentity[],
  ): Promise<RunConfigurationRuntimeWorkerReconciliation> {
    const expected = new Map(
      identities.map((identity) => [identity.runtimeId, identity]),
    );
    const runtimes = identities.map((identity) => this.status(identity));
    const orphaned = [...this.#runtimes.values()]
      .filter((session) => {
        const identity = expected.get(session.runtimeId);
        return (
          activeState(session.state) &&
          (!identity || !generationIdentityMatches(session, identity))
        );
      })
      .slice(0, RUN_CONFIGURATION_RUNTIME_LIST_LIMIT);
    await Promise.all(
      orphaned.map((session) => this.#markLost(session.runtimeId)),
    );
    return runConfigurationRuntimeWorkerReconciliationSchema.parse({
      runtimes,
      orphanedRuntimeIds: orphaned.map(({ runtimeId }) => runtimeId),
    });
  }

  async stopProject(projectId: string): Promise<number> {
    return this.#stopMatching((session) => session.projectId === projectId);
  }

  async stopForPath(targetPath: string): Promise<number> {
    const canonical = await realpath(targetPath).catch(() =>
      path.resolve(targetPath),
    );
    const matching = new Set(
      (
        await Promise.all(
          [...this.#runtimes.values()].map(async (session) => {
            const source = await realpath(
              session.sourceRoot ?? session.requestedSourcePath,
            ).catch(() =>
              path.resolve(session.sourceRoot ?? session.requestedSourcePath),
            );
            const target = await realpath(
              session.targetRoot ?? session.requestedTargetPath,
            ).catch(() =>
              path.resolve(session.targetRoot ?? session.requestedTargetPath),
            );
            return pathIsAtOrInside(canonical, source) ||
              pathIsAtOrInside(canonical, target)
              ? session.runtimeId
              : null;
          }),
        )
      ).filter((runtimeId): runtimeId is string => runtimeId !== null),
    );
    return this.#stopMatching((session) => matching.has(session.runtimeId));
  }

  async closeAll(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    const launchTasks = [...this.#runtimes.values()]
      .map(({ launchTask }) => launchTask)
      .filter((task): task is Promise<void> => task !== null);
    await Promise.all(
      [...this.#runtimes.values()]
        .filter((session) => activeState(session.state) || session.process)
        .map((session) => this.#markLost(session.runtimeId)),
    );
    await Promise.allSettled(launchTasks);
  }

  #launch(session: RuntimeSession, command: LaunchCommand): void {
    const task = this.#launchGeneration(session, command).finally(() => {
      if (session.launchTask === task) session.launchTask = null;
    });
    session.launchTask = task;
    void task;
  }

  async #launchGeneration(
    session: RuntimeSession,
    command: LaunchCommand,
  ): Promise<void> {
    try {
      const roots = await this.#authorize(command);
      if (!generationLaunchIsCurrent(session, command.identity)) return;
      session.sourceRoot = roots.sourceRoot;
      session.targetRoot = roots.targetRoot;

      const repository = await RunConfigurationRepository.open(
        roots.sourceRoot,
      );
      const result = await repository.read(command.identity.configurationId);
      if (!result.found) {
        throw new RuntimeLaunchError(
          "definition",
          "definition-not-found",
          "The Run configuration no longer exists in Primary.",
          false,
        );
      }
      if (
        result.entry.status !== "ready" ||
        !result.entry.document ||
        !result.entry.revision
      ) {
        throw new RuntimeLaunchError(
          "definition",
          "definition-invalid",
          result.entry.diagnostics[0]?.message ??
            "The Run configuration is not valid.",
          true,
        );
      }
      if (result.entry.revision !== command.identity.definitionRevision) {
        throw new RuntimeLaunchError(
          "definition",
          "definition-revision-mismatch",
          "The Run configuration changed before this generation started.",
          true,
        );
      }
      const document = result.entry.document;
      const providerContext = {
        defaultShell:
          typeof this.#environment.SHELL === "string"
            ? this.#environment.SHELL
            : null,
        platform: platformForProvider(this.#platform),
        targetRoot: roots.targetRoot,
      };
      const materialized =
        document.provider === "shell"
          ? await shellRunConfigurationProvider.materialize(
              document,
              providerContext,
            )
          : document.provider === "node"
            ? await nodeRunConfigurationProvider.materialize(
                document,
                providerContext,
              )
            : document.provider === "java"
              ? await javaRunConfigurationProvider.materialize(
                  document,
                  providerContext,
                )
              : document.provider === "dart"
                ? await dartRunConfigurationProvider.materialize(
                    document,
                    providerContext,
                  )
                : document.provider === "flutter"
                  ? await flutterRunConfigurationProvider.materialize(
                      document,
                      providerContext,
                    )
                  : await rustRunConfigurationProvider.materialize(
                      document,
                      providerContext,
                    );
      if (!generationLaunchIsCurrent(session, command.identity)) return;
      session.stopGracePeriodMs = document.stop.gracePeriodMs;

      let layers: RunConfigurationEnvironmentLayers;
      const baseline = {
        ...stringEnvironment(process.env),
        ...stringEnvironment(this.#environment),
      };
      try {
        layers = await this.#resolveEnvironment({
          baseline,
          defaultShell: providerContext.defaultShell,
          document,
          environment: materialized.environment,
          identity: command.identity,
          platform: providerContext.platform,
          protectedSecrets: command.protectedSecrets,
          sourceRoot: roots.sourceRoot,
          targetRoot: roots.targetRoot,
          execute: (environmentCommand, environment, timeoutMs) =>
            this.#runBeforeLaunch(
              session,
              command.identity,
              environmentCommand,
              environment,
              timeoutMs,
            ),
        });
      } catch (error) {
        if (error instanceof RuntimeLaunchError) throw error;
        if (error instanceof RunConfigurationEnvironmentResolutionError) {
          throw new RuntimeLaunchError(
            "environment",
            error.code,
            error.message,
            error.retryable,
          );
        }
        throw new RuntimeLaunchError(
          "environment",
          "environment-resolution-failed",
          "The enabled environment sources could not be resolved.",
          true,
        );
      }
      if (
        layers.codexEnvironmentRevision !== undefined &&
        layers.codexEnvironmentRevision !==
          command.identity.codexEnvironmentRevision
      ) {
        throw new RuntimeLaunchError(
          "environment",
          "codex-environment-revision-mismatch",
          "The Codex environment changed before this generation started.",
          true,
        );
      }
      const environment = {
        ...baseline,
        ...boundedEnvironmentLayer(layers.codex),
        ...boundedEnvironmentLayer(layers.files),
        ...boundedEnvironmentLayer(enabledVariables(materialized.environment)),
        ...boundedEnvironmentLayer(layers.secrets),
        ...boundedEnvironmentLayer(materialized.environmentAdditions),
        ...protectedBaselineEnvironment(baseline),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        ...reservedEnvironment(session, roots.sourceRoot, roots.targetRoot),
      };

      const providerDiagnostics = await validateRunConfigurationProvider(
        document,
        { ...providerContext, allowToolInspection: true, environment },
      );
      const providerError = providerDiagnostics.find(
        ({ severity }) => severity === "error",
      );
      if (providerError) {
        throw new RuntimeLaunchError(
          "provider",
          providerError.code,
          providerError.message,
          true,
        );
      }

      for (const step of materialized.beforeLaunch) {
        const result = await this.#runBeforeLaunch(
          session,
          command.identity,
          step,
          environment,
        );
        if (!generationLaunchIsCurrent(session, command.identity)) return;
        if (result.exitCode !== 0) {
          throw new RuntimeLaunchError(
            "before-launch",
            "before-launch-failed",
            `A before-launch step exited with code ${result.exitCode}.`,
            true,
          );
        }
      }

      await this.#withLock(session.runtimeId, async () => {
        if (!generationLaunchIsCurrent(session, command.identity)) return;
        const tracked = this.#spawn(
          session,
          command.identity,
          materialized,
          environment,
          "runtime",
        );
        session.process = tracked;
        session.startedAt = new Date().toISOString();
        session.state = "running";
        this.#emit(session);
        workerLogger.event("info", "Run configuration process started", {
          event: "run-configuration.process.started",
          subsystem: "run-configuration-runtime",
          operation: "start",
          status: "running",
          runtimeId: session.runtimeId,
          projectId: session.projectId,
          worktreeId: session.worktreeId,
          configurationId: session.configurationId,
          generation: session.generation,
        });
      });
    } catch (error) {
      await this.#withLock(session.runtimeId, async () => {
        if (!generationLaunchIsCurrent(session, command.identity)) return;
        session.process = null;
        session.state = "failed";
        session.failure = boundedFailure(error);
        session.endedAt = new Date().toISOString();
        this.#emit(session);
        workerLogger.event(
          "warn",
          "Run configuration process failed to start",
          {
            event: "run-configuration.process.start-failed",
            subsystem: "run-configuration-runtime",
            operation: "start",
            reasonCode: session.failure.code,
            status: "failed",
            runtimeId: session.runtimeId,
            projectId: session.projectId,
            worktreeId: session.worktreeId,
            configurationId: session.configurationId,
            generation: session.generation,
          },
        );
      });
    }
  }

  async #runBeforeLaunch(
    session: RuntimeSession,
    identity: RunConfigurationRuntimeLaunchIdentity,
    command: MaterializedRunCommand,
    environment: Record<string, string>,
    timeoutMs?: number,
  ): Promise<ProcessExit> {
    const executable = await findRunConfigurationExecutable(
      command.executable,
      {
        environment,
        platform: platformForProvider(this.#platform),
        targetRoot: command.workingDirectory,
      },
    );
    if (!executable) {
      throw new RuntimeLaunchError(
        timeoutMs === undefined ? "before-launch" : "environment",
        "executable-unavailable",
        `The required executable ${JSON.stringify(command.executable)} is not available in the target worker launch environment. Install it or add it to PATH.`,
        true,
      );
    }
    const tracked = await this.#withLock(session.runtimeId, async () => {
      if (!generationLaunchIsCurrent(session, identity)) {
        return null;
      }
      const child = this.#spawn(
        session,
        identity,
        command,
        environment,
        "before-launch",
      );
      session.process = child;
      return child;
    });
    if (!tracked) return { exitCode: 1, signal: null };
    if (timeoutMs === undefined) return tracked.exit;
    const result = await this.#waitForExitOrTimeout(tracked, timeoutMs);
    if (result) return result;
    await this.#terminateTracked(tracked, 0, true);
    throw new RuntimeLaunchError(
      "environment",
      "codex-environment-setup-timeout",
      "The Codex environment setup exceeded its bounded execution time.",
      true,
    );
  }

  #spawn(
    session: RuntimeSession,
    identity: RunConfigurationRuntimeLaunchIdentity,
    command: MaterializedRunCommand,
    environment: Record<string, string>,
    phase: TrackedProcess["phase"],
  ): TrackedProcess {
    ensureSpawnHelperExecutable();
    let resolveExit!: (result: ProcessExit) => void;
    const exit = new Promise<ProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    const child = pty.spawn(command.executable, command.arguments, {
      cols: 120,
      rows: 40,
      cwd: command.workingDirectory,
      env: environment,
      name: "xterm-256color",
    });
    const tracked: TrackedProcess = {
      child,
      exit,
      generation: identity.generation,
      operationId: identity.operationId,
      phase,
    };
    child.onData((data) => {
      if (session.process !== tracked) return;
      this.#appendOutput(session, data);
    });
    child.onExit(({ exitCode, signal }) => {
      if (session.process === tracked) session.process = null;
      const result = { exitCode, signal: processSignal(signal) };
      resolveExit(result);
      if (phase === "runtime") {
        void this.#recordNaturalExit(session.runtimeId, identity, result);
      }
    });
    return tracked;
  }

  async #recordNaturalExit(
    runtimeId: string,
    identity: RunConfigurationRuntimeLaunchIdentity,
    result: ProcessExit,
  ): Promise<void> {
    await this.#withLock(runtimeId, async () => {
      const session = this.#runtimes.get(runtimeId);
      if (
        !session ||
        session.state !== "running" ||
        !generationIdentityMatches(session, identity)
      ) {
        return;
      }
      session.state = "exited";
      session.endedAt = new Date().toISOString();
      session.exitCode = result.exitCode;
      session.signal = result.signal;
      this.#emit(session);
    });
  }

  async #terminateTracked(
    tracked: TrackedProcess,
    gracePeriodMs: number,
    forceImmediately: boolean,
  ): Promise<ProcessExit> {
    if (forceImmediately) {
      await this.#signalProcessTree(tracked.child, true);
      return this.#waitForExit(tracked, FORCE_EXIT_WAIT_MS);
    }
    await this.#signalProcessTree(tracked.child, false);
    const graceful = await this.#waitForExitOrTimeout(tracked, gracePeriodMs);
    if (graceful) return graceful;
    await this.#signalProcessTree(tracked.child, true);
    return this.#waitForExit(tracked, FORCE_EXIT_WAIT_MS);
  }

  async #waitForExit(
    tracked: TrackedProcess,
    timeoutMs: number,
  ): Promise<ProcessExit> {
    const result = await this.#waitForExitOrTimeout(tracked, timeoutMs);
    if (result) return result;
    throw new RuntimeLaunchError(
      "stop",
      "termination-unconfirmed",
      "The Run process group did not confirm termination after force kill.",
      true,
    );
  }

  #waitForExitOrTimeout(
    tracked: TrackedProcess,
    timeoutMs: number,
  ): Promise<ProcessExit | null> {
    if (timeoutMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref();
      void tracked.exit.then((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  async #signalProcessTree(child: pty.IPty, force: boolean): Promise<void> {
    await this.#processTree.signal(child, force);
  }

  async #markLost(runtimeId: string): Promise<void> {
    await this.#withLock(runtimeId, async () => {
      const session = this.#runtimes.get(runtimeId);
      if (!session || (!activeState(session.state) && !session.process)) return;
      const tracked = session.process;
      session.state = "lost";
      session.failure = {
        phase: "reconcile",
        code: "runtime-unclaimed",
        message: "The worker stopped an unclaimed Run configuration process.",
        retryable: true,
      };
      if (tracked) await this.#terminateTracked(tracked, 0, true);
      session.process = null;
      session.endedAt = new Date().toISOString();
      this.#emit(session);
    });
  }

  async #stopMatching(
    matches: (session: RuntimeSession) => boolean,
  ): Promise<number> {
    const runtimeIds = [...this.#runtimes.values()]
      .filter(
        (session) =>
          matches(session) && (activeState(session.state) || session.process),
      )
      .map(({ runtimeId }) => runtimeId);
    await Promise.all(runtimeIds.map((runtimeId) => this.#markLost(runtimeId)));
    return runtimeIds.length;
  }

  #beginGeneration(
    session: RuntimeSession,
    command: LaunchCommand,
    state: "restarting" | "starting",
  ): void {
    Object.assign(session, command.identity);
    session.requestedRootKind = command.rootKind;
    session.requestedSourcePath = command.sourcePath;
    session.requestedTargetPath = command.targetPath;
    session.sourceRoot = null;
    session.targetRoot = null;
    session.state = state;
    session.startedAt = null;
    session.endedAt = null;
    session.exitCode = null;
    session.signal = null;
    session.failure = null;
    this.#emit(session);
  }

  #assertStableIdentity(
    session: RuntimeSession,
    identity: RunConfigurationRuntimeWorkerIdentity,
  ): void {
    if (!stableIdentityMatches(session, identity)) {
      throw new Error(
        "The runtime ID is already bound to another Run configuration identity.",
      );
    }
  }

  #operationResult(
    outcome: RunConfigurationRuntimeWorkerOperationResult["outcome"],
    session: RuntimeSession | null,
  ): RunConfigurationRuntimeWorkerOperationResult {
    return runConfigurationRuntimeWorkerOperationResultSchema.parse({
      outcome,
      observation: session ? this.#observation(session) : null,
    });
  }

  #observation(
    session: RuntimeSession,
  ): RunConfigurationRuntimeWorkerObservation {
    return runConfigurationRuntimeWorkerObservationSchema.parse({
      runtimeId: session.runtimeId,
      projectId: session.projectId,
      configurationId: session.configurationId,
      worktreeId: session.worktreeId,
      workerId: session.workerId,
      definitionRevision: session.definitionRevision,
      codexEnvironmentRevision: session.codexEnvironmentRevision,
      generation: session.generation,
      operationId: session.operationId,
      terminalId: session.terminalId,
      state: session.state,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      exitCode: session.exitCode,
      signal: session.signal,
      failure: session.failure,
    });
  }

  #emit(session: RuntimeSession): void {
    try {
      this.#notify(this.#observation(session));
    } catch {
      // Reconciliation recovers observations lost with the command channel.
    }
  }

  #appendOutput(session: RuntimeSession, data: string): void {
    session.buffer = `${session.buffer}${data}`.slice(-MAX_SCROLLBACK_CHARS);
  }

  #appendDivider(session: RuntimeSession, label: string): void {
    this.#appendOutput(
      session,
      `\r\n\x1b[90m[${label} · generation ${session.generation}]\x1b[0m\r\n`,
    );
  }

  #evictCompleted(): void {
    if (this.#runtimes.size < MAX_RETAINED_RUNTIMES) return;
    const completed = [...this.#runtimes.values()]
      .filter((session) => !activeState(session.state))
      .sort((left, right) =>
        (left.endedAt ?? "").localeCompare(right.endedAt ?? ""),
      );
    while (
      this.#runtimes.size >= MAX_RETAINED_RUNTIMES &&
      completed.length > 0
    ) {
      this.#runtimes.delete(completed.shift()!.runtimeId);
    }
  }

  async #withLock<T>(
    runtimeId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#locks.get(runtimeId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(runtimeId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(runtimeId) === current) this.#locks.delete(runtimeId);
    }
  }
}
