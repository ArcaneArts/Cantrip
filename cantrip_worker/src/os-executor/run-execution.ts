import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { cantripOsExecutionSchema } from "@cantrip/protocol";
import { runConfigurationRuntimeLaunchIdentitySchema } from "@cantrip/protocol/run-configuration-runtime";
import {
  runConfigurationProtectedSecretListSchema,
  type RunConfigurationProtectedSecret,
} from "@cantrip/protocol/run-configuration-secrets";
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

export const osRunLaunchSchema = z
  .object({
    identity: runConfigurationRuntimeLaunchIdentitySchema,
    definitions: cantripOsExecutionSchema,
    target: cantripOsExecutionSchema,
    protectedSecrets: runConfigurationProtectedSecretListSchema,
  })
  .strict();
export type OsRunLaunch = z.infer<typeof osRunLaunchSchema>;
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
    const job = new OsRunGeneration(this, input, fingerprint, callbacks);
    this.active.set(key, job);
    void job.completion.finally(() => this.active.delete(key));
    return job;
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
  ) {
    const identity = input.identity;
    this.file = path.join(
      driver.directory,
      "os-run-generations",
      identity.runtimeId,
      `${identity.generation}.json`,
    );
    this.record = {
      version: 1,
      identity,
      definitions: input.definitions,
      target: input.target,
      fingerprint,
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
      if (!known && process.phase === "runtime" && !this.stopping)
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
      if (process.tty)
        await this.connection!.request("process/resize", {
          processId: process.id,
          cols: 120,
          rows: 40,
        });
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
        if (saved.result && saved.result.outcome !== "unknown")
          return saved.result;
      } else {
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
        if (!saved.native || last?.phase !== "runtime")
          return {
            outcome: "unknown",
            phase: "reconcile",
            code: "linux-preparation-interrupted",
            message:
              "The previous preparation has no admitted runtime process; it was not repeated.",
          };
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
      const result: OsRunResult = this.record.processes.length
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
