import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import {
  cantripOsRunLaunchSchema,
  cantripOsRunCaptureSchema,
  type CantripOsRunCapture,
  type CantripOsRunLaunch,
} from "@cantrip/protocol";
import type { RunConfigurationProtectedSecret } from "@cantrip/protocol/run-configuration-secrets";
import type { CantripOsController } from "./controller.js";
import {
  OsExecutorConnection,
  OsExecutorDeliveryError,
  type OsExecutorBinding,
} from "./connection.js";
import { guestFileUri } from "./paths.js";
import { durableTerminalJson } from "./terminal-launcher.js";
import {
  osRunPlanResponseSchema,
  type OsRunPlan,
} from "./run-plan-contract.js";
import { RunConfigurationOutputRedactor } from "../run-configuration-output-redactor.js";

export const osRunLaunchSchema = cantripOsRunLaunchSchema;
export type OsRunLaunch = CantripOsRunLaunch;
export type OsRunResult =
  | {
      outcome: "exited" | "interrupted";
      exitCode: number | null;
      signal: string | null;
    }
  | {
      outcome: "failed" | "unknown";
      phase: string;
      code: string;
      message: string;
    };
export interface OsRunCallbacks {
  output(data: string): void;
  started(stopGracePeriodMs: number): void;
}
type ProcessRecord = {
  id: string;
  phase: "prepare" | "before-launch" | "runtime";
  tty: boolean;
  exited: boolean;
};
interface RunJournal {
  version: 1;
  identity: OsRunLaunch["identity"];
  definitions: OsRunLaunch["definitions"];
  target: OsRunLaunch["target"];
  fingerprint: string;
  protectedSecrets?: RunConfigurationProtectedSecret[];
  native: { sessionId: string; executorGeneration: string } | null;
  processes: ProcessRecord[];
  result: OsRunResult | null;
  diagnostic?: string;
  stopRequested?: boolean;
  gracefulWriteId?: string;
  stopGracePeriodMs?: number;
}
interface Read {
  chunks: { seq: number; stream: string; chunk: string }[];
  nextSeq: number;
  exited: boolean;
  closed: boolean;
  exitCode: number | null;
  failure: string | null;
}
const digest = (input: unknown) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");

/** One generation's execution driver. All admission, lifecycle decisions, keys,
 * callbacks and native process ownership remain on the existing Worker. */
export class OsRunExecution {
  private readonly active = new Map<string, OsRunGeneration>();
  constructor(
    readonly directory: string,
    readonly controller: Pick<CantripOsController, "captureExecutionBinding">,
    readonly authority: { ownerId(): string; serverIdentity(): string },
    readonly openSecret: (
      projectId: string,
      secret: RunConfigurationProtectedSecret,
    ) => Promise<string>,
  ) {}
  start(supplied: OsRunLaunch, callbacks: OsRunCallbacks) {
    return this.generation(supplied, callbacks, false);
  }

  /** Recover only an already admitted generation. Missing or mismatched records
   * cannot fall through to preparation, process/start or input delivery. */
  async resume(supplied: CantripOsRunCapture, callbacks: OsRunCallbacks) {
    const capture = cantripOsRunCaptureSchema.parse(supplied);
    if (
      capture.definitions.scope.ownerId !== this.authority.ownerId() ||
      capture.target.scope.ownerId !== this.authority.ownerId()
    )
      throw new Error("The Linux Run belongs to another account.");
    const file = path.join(
      this.directory,
      "os-run-generations",
      capture.identity.runtimeId,
      `${capture.identity.generation}.json`,
    );
    let saved: RunJournal;
    try {
      saved = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (
      saved.version !== 1 ||
      !isDeepStrictEqual(saved.identity, capture.identity) ||
      !isDeepStrictEqual(saved.definitions, capture.definitions) ||
      !isDeepStrictEqual(saved.target, capture.target)
    )
      throw new Error(
        "The Linux Run recovery differs from its captured admission.",
      );
    const input = osRunLaunchSchema.parse({
      identity: saved.identity,
      definitions: saved.definitions,
      target: saved.target,
      protectedSecrets: saved.protectedSecrets ?? [],
    });
    if (digest(input) !== saved.fingerprint)
      throw new Error(
        "The sealed Linux Run admission is unavailable; no process was replaced.",
      );
    return this.generation(input, callbacks, true, saved);
  }

  private generation(
    supplied: OsRunLaunch,
    callbacks: OsRunCallbacks,
    resumeOnly: boolean,
    saved?: RunJournal,
  ) {
    const input = osRunLaunchSchema.parse(supplied);
    const { scope: s } = input.definitions,
      { scope: t } = input.target;
    if (
      s.ownerId !== this.authority.ownerId() ||
      t.ownerId !== s.ownerId ||
      t.projectId !== input.identity.projectId ||
      s.projectId !== t.projectId ||
      t.worktreeId !== input.identity.worktreeId ||
      t.workerId !== input.identity.workerId ||
      s.workerId !== t.workerId ||
      s.projectSourceId !== t.projectSourceId ||
      s.instanceId !== t.instanceId ||
      s.guestInstanceId !== t.guestInstanceId ||
      s.workspaceId !== t.workspaceId ||
      s.guestWorkspaceId !== t.guestWorkspaceId ||
      s.uid !== t.uid ||
      s.gid !== t.gid ||
      s.attachmentGeneration !== t.attachmentGeneration ||
      s.runtimeGeneration !== t.runtimeGeneration ||
      !isDeepStrictEqual(input.definitions.transport, input.target.transport)
    )
      throw new Error(
        "The Run definition and target belong to different Linux authority.",
      );
    const key = `${input.identity.runtimeId}/${input.identity.generation}`;
    const fingerprint = digest(input);
    const existing = this.active.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error(
          "The Linux Run generation already has another admission.",
        );
      return existing;
    }
    const job = new OsRunGeneration(
      this,
      input,
      fingerprint,
      callbacks,
      resumeOnly,
      saved,
    );
    this.active.set(key, job);
    void job.completion.then(
      () => this.active.delete(key),
      () => this.active.delete(key),
    );
    return job;
  }

  /** Reconcile a known generation after Worker memory was lost. Only its
   * admitted native handles are stopped; no command or input is replayed. */
  async stopRecorded(supplied: CantripOsRunCapture): Promise<OsRunResult> {
    const input = cantripOsRunCaptureSchema.parse(supplied);
    if (
      input.target.scope.ownerId !== this.authority.ownerId() ||
      input.definitions.scope.ownerId !== this.authority.ownerId()
    )
      throw new Error("The Linux Run belongs to another account.");
    const file = path.join(
      this.directory,
      "os-run-generations",
      input.identity.runtimeId,
      `${input.identity.generation}.json`,
    );
    let saved: RunJournal;
    try {
      saved = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        outcome: "unknown",
        phase: "reconcile",
        code: "linux-admission-unavailable",
        message:
          "The recorded Linux Run admission is unavailable; no replacement process was started.",
      };
    }
    if (
      saved.version !== 1 ||
      !isDeepStrictEqual(saved.definitions, input.definitions) ||
      !isDeepStrictEqual(saved.target, input.target) ||
      [
        "runtimeId",
        "projectId",
        "configurationId",
        "worktreeId",
        "workerId",
        "terminalId",
        "generation",
        "definitionRevision",
        "codexEnvironmentRevision",
      ].some(
        (key) =>
          Reflect.get(saved.identity, key) !== Reflect.get(input.identity, key),
      )
    )
      throw new Error(
        "The Linux Run cleanup differs from its captured placement.",
      );
    const pending = saved.processes.filter((process) => !process.exited);
    if (!pending.length)
      return {
        outcome: "interrupted",
        exitCode:
          saved.result && "exitCode" in saved.result
            ? saved.result.exitCode
            : null,
        signal: null,
      };
    if (!saved.native)
      return {
        outcome: "unknown",
        phase: "reconcile",
        code: "linux-session-unavailable",
        message:
          "The admitted native session is unavailable; its process was not replaced.",
      };
    const binding = await this.controller.captureExecutionBinding(
      input.target.transport,
      { ...input.target.scope, serverId: this.authority.serverIdentity() },
    );
    if (binding.executor_generation !== saved.native.executorGeneration)
      return {
        outcome: "unknown",
        phase: "reconcile",
        code: "linux-session-changed",
        message:
          "The native executor changed before termination could be confirmed.",
      };
    const connection = new OsExecutorConnection(
      input.target.transport,
      binding,
    );
    let exitCode: number | null = null;
    try {
      const initialized = await connection.request<{ sessionId: string }>(
        "initialize",
        {
          clientName: "cantrip-run-reconcile-stop",
          resumeSessionId: saved.native.sessionId,
        },
      );
      connection.notify("initialized");
      if (initialized.sessionId !== saved.native.sessionId)
        throw new Error("The native Run session changed.");
      saved.stopRequested = true;
      await durableTerminalJson(file, saved);
      for (const process of pending) {
        const terminated = await connection.request<{ running: boolean }>(
          "process/terminate",
          { processId: process.id },
        );
        if (terminated.running) {
          const deadline = Date.now() + 10_000;
          for (;;) {
            const observed = await connection.request<Read>("process/read", {
              processId: process.id,
              afterSeq: null,
              maxBytes: 1,
              waitMs: 200,
            });
            if (observed.exited && observed.closed) {
              exitCode = observed.exitCode;
              break;
            }
            if (Date.now() >= deadline)
              throw new Error("The native Run did not confirm termination.");
          }
        }
        process.exited = true;
      }
      const result: OsRunResult = {
        outcome: "interrupted",
        exitCode,
        signal: null,
      };
      saved.result = result;
      await durableTerminalJson(file, saved);
      return result;
    } catch (error) {
      return {
        outcome: "unknown",
        phase: "reconcile",
        code: "linux-termination-unknown",
        message:
          "Linux Run termination is unconfirmed. No replacement was started.",
      };
    } finally {
      await connection.close();
    }
  }

  /** A new explicit generation cannot overlap an unresolved older native
   * generation of this same durable runtime. */
  async stopPrior(input: OsRunLaunch) {
    const directory = path.join(
      this.directory,
      "os-run-generations",
      input.identity.runtimeId,
    );
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      if (
        !/^\d+\.json$/.test(name) ||
        Number(name.slice(0, -5)) >= input.identity.generation
      )
        continue;
      const saved = JSON.parse(
        await readFile(path.join(directory, name), "utf8"),
      ) as RunJournal;
      if (
        saved.version !== 1 ||
        !isDeepStrictEqual(saved.definitions, input.definitions) ||
        !isDeepStrictEqual(saved.target, input.target) ||
        [
          "runtimeId",
          "projectId",
          "configurationId",
          "worktreeId",
          "workerId",
          "terminalId",
        ].some(
          (key) =>
            Reflect.get(saved.identity, key) !==
            Reflect.get(input.identity, key),
        )
      )
        throw new Error(
          "The durable Run cannot move to a different Linux placement.",
        );
      if (!saved.processes.some((process) => !process.exited)) continue;
      const result = await this.stopRecorded({
        identity: saved.identity,
        definitions: saved.definitions,
        target: saved.target,
      });
      if (result.outcome === "unknown")
        throw new Error(
          "The previous Linux Run generation has an unknown termination outcome.",
        );
    }
  }
}

export class OsRunGeneration {
  readonly completion: Promise<OsRunResult>;
  private record: RunJournal;
  private connection: OsExecutorConnection | null = null;
  private binding: OsExecutorBinding | null = null;
  private stopping = false;
  private current: ProcessRecord | null = null;
  private dispatched = new Set<string>();
  private journalReady = false;
  private redactor = new RunConfigurationOutputRedactor([]);
  private file: string;
  constructor(
    private readonly driver: OsRunExecution,
    private readonly input: OsRunLaunch,
    readonly fingerprint: string,
    private readonly callbacks: OsRunCallbacks,
    private readonly resumeOnly = false,
    saved?: RunJournal,
  ) {
    const identity = input.identity;
    this.file = path.join(
      driver.directory,
      "os-run-generations",
      identity.runtimeId,
      `${identity.generation}.json`,
    );
    this.record = saved ?? {
      version: 1,
      identity,
      definitions: input.definitions,
      target: input.target,
      fingerprint,
      protectedSecrets: input.protectedSecrets,
      native: null,
      processes: [],
      result: null,
    };
    this.completion = Promise.resolve().then(() => this.run());
  }
  private save() {
    return durableTerminalJson(this.file, this.record);
  }
  private emit(data: string) {
    const value = this.redactor.write(data);
    if (value) this.callbacks.output(value);
  }
  private async connect(resume: boolean) {
    if (!this.binding) throw new Error("Linux Run capability is unavailable.");
    await this.connection?.close();
    const connection = new OsExecutorConnection(
      this.input.target.transport,
      this.binding,
    );
    this.connection = connection;
    const expected = this.record.native;
    const initialized = await connection.request<{ sessionId: string }>(
      "initialize",
      {
        clientName: "cantrip-run-execution",
        resumeSessionId: resume ? expected?.sessionId : null,
      },
    );
    connection.notify("initialized");
    if (
      resume &&
      (!expected ||
        expected.sessionId !== initialized.sessionId ||
        expected.executorGeneration !== this.binding.executor_generation)
    )
      throw new OsExecutorDeliveryError(
        "The Linux Run native session changed; no process was replayed.",
      );
    this.record.native = {
      sessionId: initialized.sessionId,
      executorGeneration: this.binding.executor_generation,
    };
    if (!resume) await this.save();
    return connection;
  }
  private async read(process: ProcessRecord, capture: boolean) {
    let sequence: number | null = null,
      stdout = "",
      stderr = "",
      bytes = 0,
      known = false;
    const deadline =
      process.phase === "prepare"
        ? Date.now() + 180_000
        : process.phase === "before-launch"
          ? Date.now() + 30 * 60_000
          : Infinity;
    let terminationDeadline: number | null = null;
    const decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
      pty: new StringDecoder("utf8"),
    };
    for (;;) {
      if (Date.now() >= deadline && terminationDeadline === null) {
        await this.connection!.request("process/terminate", {
          processId: process.id,
        });
        terminationDeadline = Date.now() + 10_000;
      }
      let value: Read;
      try {
        value = await this.connection!.request<Read>("process/read", {
          processId: process.id,
          afterSeq: sequence,
          maxBytes: 65536,
          waitMs: 200,
        });
      } catch (error) {
        if (!(error instanceof OsExecutorDeliveryError)) throw error;
        await this.connect(true);
        value = await this.connection!.request<Read>("process/read", {
          processId: process.id,
          afterSeq: sequence,
          maxBytes: 65536,
          waitMs: 200,
        });
      }
      sequence = Math.max(0, value.nextSeq - 1);
      if (
        !known &&
        !value.exited &&
        process.phase === "runtime" &&
        !this.stopping
      )
        this.callbacks.started(this.stopGracePeriodMs);
      known = true;
      for (const chunk of value.chunks) {
        if (
          chunk.stream !== "stdout" &&
          chunk.stream !== "stderr" &&
          chunk.stream !== "pty"
        )
          continue;
        const data = Buffer.from(chunk.chunk, "base64");
        const text = decoders[chunk.stream].write(data);
        if (capture) {
          bytes += data.length;
          if (bytes > 8 * 1024 * 1024)
            throw new Error("Linux Run preparation output exceeded its bound.");
          if (chunk.stream === "stdout") stdout += text;
          else stderr += text;
        } else this.emit(text);
      }
      if (value.exited && value.closed && !value.chunks.length) {
        process.exited = true;
        await this.save();
        if (capture) {
          stdout += decoders.stdout.end();
          stderr += decoders.stderr.end();
        } else {
          this.emit(decoders.stdout.end());
          this.emit(decoders.stderr.end());
          this.emit(decoders.pty.end());
        }
        return { exitCode: value.exitCode, stdout, stderr };
      }
      if (value.failure || (value.closed && !value.exited))
        throw new OsExecutorDeliveryError(
          "The Linux Run process closed without a confirmed exit.",
        );
      if (terminationDeadline !== null && Date.now() >= terminationDeadline)
        throw new OsExecutorDeliveryError(
          "The Linux preparation timeout has no confirmed termination.",
        );
    }
  }
  private async process(
    command: OsRunPlan["command"],
    environment: Record<string, string>,
    phase: ProcessRecord["phase"],
    stdin?: string,
  ) {
    if (this.stopping) return { exitCode: null, stdout: "", stderr: "" };
    const process: ProcessRecord = {
      id: randomUUID(),
      phase,
      tty: phase !== "prepare",
      exited: false,
    };
    this.record.processes.push(process);
    this.current = process;
    await this.save();
    if (this.stopping) {
      process.exited = true;
      await this.save();
      this.current = null;
      return { exitCode: null, stdout: "", stderr: "" };
    }
    this.dispatched.add(process.id);
    try {
      await this.connection!.request("process/start", {
        processId: process.id,
        argv: [
          "/usr/lib/cantrip-os-executor/process-owner",
          command.executable,
          ...command.arguments,
        ],
        cwd: guestFileUri(command.workingDirectory),
        env: environment,
        tty: process.tty,
        pipeStdin: stdin !== undefined,
        arg0: null,
        sandbox: null,
      });
      if (process.tty) {
        try {
          await this.connection!.request("process/resize", {
            processId: process.id,
            cols: 120,
            rows: 40,
          });
        } catch (error) {
          if (error instanceof OsExecutorDeliveryError) throw error;
          // A short-lived process can finish before resize reaches its PTY.
          // Confirm that actual outcome; an unavailable live PTY still fails.
          const observed = await this.connection!.request<Read>(
            "process/read",
            { processId: process.id, afterSeq: null, maxBytes: 1, waitMs: 0 },
          );
          if (!observed.exited || !observed.closed) throw error;
        }
      }
      if (stdin !== undefined) {
        const input = Buffer.from(stdin);
        for (let offset = 0; offset < input.length; offset += 32768) {
          if (this.stopping) break;
          const result = await this.connection!.request<{ status: string }>(
            "process/write",
            {
              processId: process.id,
              writeId: randomUUID(),
              chunk: input.subarray(offset, offset + 32768).toString("base64"),
            },
          );
          if (result.status !== "accepted")
            throw new OsExecutorDeliveryError(
              "Linux preparation input was not acknowledged.",
            );
        }
      }
    } catch (error) {
      if (!(error instanceof OsExecutorDeliveryError)) throw error;
      // Start/input delivery is uncertain. Resume and observe the admitted ID;
      // never issue another start or resend any input chunk.
      await this.connect(true);
    }
    const result = await this.read(process, phase === "prepare");
    this.current = null;
    return result;
  }
  private stopGracePeriodMs = 3000;
  async signal(force: boolean) {
    this.stopping = true;
    this.record.stopRequested = true;
    if (this.journalReady) await this.save();
    const process = this.current;
    if (
      !process ||
      process.exited ||
      !this.dispatched.has(process.id) ||
      !this.connection
    )
      return;
    if (force || !process.tty)
      await this.connection.request("process/terminate", {
        processId: process.id,
      });
    else {
      this.record.gracefulWriteId ??= randomUUID();
      await this.save();
      if (!process.exited)
        await this.connection.request("process/write", {
          processId: process.id,
          writeId: this.record.gracefulWriteId,
          chunk: Buffer.from([3]).toString("base64"),
        });
    }
  }
  private async run(): Promise<OsRunResult> {
    let admission = false;
    try {
      const serverId = this.driver.authority.serverIdentity();
      await this.driver.controller.captureExecutionBinding(
        this.input.definitions.transport,
        { ...this.input.definitions.scope, serverId },
      );
      this.binding = await this.driver.controller.captureExecutionBinding(
        this.input.target.transport,
        { ...this.input.target.scope, serverId },
      );
      if (!this.resumeOnly) await this.driver.stopPrior(this.input);
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      let saved: RunJournal | null = null;
      try {
        saved = JSON.parse(await readFile(this.file, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (saved) {
        if (saved.version !== 1 || saved.fingerprint !== this.fingerprint)
          throw new Error("The Linux Run admission changed.");
        this.record = saved;
        this.stopping ||= Boolean(saved.stopRequested);
        this.stopGracePeriodMs = saved.stopGracePeriodMs ?? 3000;
        if (
          !this.resumeOnly &&
          saved.result &&
          saved.result.outcome !== "unknown"
        )
          return saved.result;
      } else {
        if (this.resumeOnly)
          throw new OsExecutorDeliveryError(
            "The recorded Linux Run admission disappeared; no process was started.",
          );
        await durableTerminalJson(this.file, this.record, true);
        admission = true;
      }
      this.journalReady = true;
      const secrets = [];
      for (const secret of this.input.protectedSecrets)
        secrets.push({
          reference: secret.reference,
          value: await this.driver.openSecret(
            this.input.identity.projectId,
            secret,
          ),
        });
      this.redactor = new RunConfigurationOutputRedactor(
        secrets.map((item) => item.value),
      );
      if (saved) {
        const last = saved.processes.at(-1);
        if (!saved.native || last?.phase !== "runtime") {
          if (saved.result && saved.result.outcome !== "unknown") {
            this.callbacks.output(
              "\r\n[Earlier Linux preparation output was not recovered; preparation was not repeated.]\r\n",
            );
            return saved.result;
          }
          return {
            outcome: "unknown",
            phase: "reconcile",
            code: "linux-preparation-interrupted",
            message:
              "The previous preparation has no admitted runtime process; it was not repeated.",
          };
        }
        this.current = last;
        this.dispatched.add(last.id);
        await this.connect(true);
        if (this.stopping) await this.signal(true);
        const observed = await this.read(last, false);
        return this.finish({
          outcome: this.stopping ? "interrupted" : "exited",
          exitCode: observed.exitCode,
          signal: null,
        });
      }
      await this.connect(false);
      if (this.stopping)
        return this.finish({
          outcome: "interrupted",
          exitCode: null,
          signal: null,
        });
      const prepared = await this.process(
        {
          executable: "/usr/bin/node",
          arguments: ["/usr/lib/cantrip-os-executor/run-plan.mjs"],
          workingDirectory: this.input.target.scope.guestPath,
        },
        {},
        "prepare",
        JSON.stringify({
          identity: this.input.identity,
          sourceRoot: this.input.definitions.scope.guestPath,
          targetRoot: this.input.target.scope.guestPath,
          secrets,
        }) + "\n",
      );
      if (this.stopping)
        return this.finish({
          outcome: "interrupted",
          exitCode: prepared.exitCode,
          signal: null,
        });
      if (prepared.exitCode !== 0)
        throw new OsExecutorDeliveryError(
          `The Linux preparation child has no valid completion: ${this.redactor.redactComplete(prepared.stderr.slice(-4000))}`,
        );
      const plan = osRunPlanResponseSchema.parse(JSON.parse(prepared.stdout));
      if (plan.state === "failed")
        return this.finish({
          outcome: "failed",
          phase: plan.phase,
          code: plan.code,
          message: this.redactor.redactComplete(plan.message),
        });
      this.stopGracePeriodMs = plan.stopGracePeriodMs;
      this.record.stopGracePeriodMs = plan.stopGracePeriodMs;
      this.emit(plan.preparationOutput);
      for (const command of plan.beforeLaunch) {
        const result = await this.process(
          command,
          plan.environment,
          "before-launch",
        );
        if (this.stopping)
          return this.finish({
            outcome: "interrupted",
            exitCode: result.exitCode,
            signal: null,
          });
        if (result.exitCode !== 0)
          return this.finish({
            outcome: "failed",
            phase: "before-launch",
            code: "before-launch-failed",
            message: `A Linux before-launch step exited with code ${result.exitCode}.`,
          });
      }
      const result = await this.process(
        plan.command,
        plan.environment,
        "runtime",
      );
      return this.finish({
        outcome: this.stopping ? "interrupted" : "exited",
        exitCode: result.exitCode,
        signal: null,
      });
    } catch (error) {
      if (
        this.resumeOnly &&
        this.record.result &&
        this.record.result.outcome !== "unknown"
      ) {
        this.callbacks.output(
          "\r\n[The prior Run completion was retained; its output could not be fully recovered.]\r\n",
        );
        return this.record.result;
      }
      const result: OsRunResult =
        this.resumeOnly || this.record.processes.length
          ? {
              outcome: "unknown",
              phase: "reconcile",
              code: "linux-outcome-unknown",
              message:
                "The Linux Run outcome is unknown. Its admitted process was not replaced.",
            }
          : {
              outcome: "failed",
              phase: admission ? "environment" : "target",
              code: "linux-launch-unavailable",
              message:
                "The Linux Run did not reach process launch. Inspect its Worker diagnostics.",
            };
      this.record.diagnostic = this.redactor.redactComplete(
        error instanceof Error
          ? error.message.slice(0, 4000)
          : "Linux execution failed.",
      );
      if (admission) await this.finish(result).catch(() => undefined);
      return result;
    } finally {
      const tail = this.redactor.flush();
      if (tail) this.callbacks.output(tail);
      await this.connection?.close();
    }
  }
  private async finish(result: OsRunResult) {
    this.record.result = result;
    await this.save();
    return result;
  }
}
