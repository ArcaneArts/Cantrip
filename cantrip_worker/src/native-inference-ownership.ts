import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { InferenceJournalCommand } from "./inference-journal.js";
import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";

/** Backed by locks held by actual native processes, never launcher PIDs. */
export interface NativeInferenceOwnership {
  readonly available: boolean;
  onLost(listener: () => void): void;
  prepare(runtimeGeneration: string): Promise<NodeJS.ProcessEnv>;
  retire(runtimeGeneration: string): Promise<void>;
  close(): Promise<void>;
  journal(command: InferenceJournalCommand): Promise<unknown>;
}

/** One keeper per server/owner/worker scope, shared by all its native runtimes. */
export class LocalNativeInferenceOwnership implements NativeInferenceOwnership {
  private readonly directory: string;
  private readonly lostListeners = new Set<() => void>();
  private owned = false;
  private closed = false;
  private owner: Promise<void> | null = null;
  private keeper: ChildProcessWithoutNullStreams | null = null;
  private readonly journalRequests = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      deadline: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly binary: string,
    dataDirectory: string,
    private readonly scope: {
      serverId: string;
      ownerId: string;
      workerId: string;
      workerGeneration: string;
    },
    private readonly onRecoveryError: (error: unknown) => void,
  ) {
    const key = createHash("sha256")
      .update(JSON.stringify([scope.serverId, scope.ownerId, scope.workerId]))
      .digest("hex");
    this.directory = path.resolve(dataDirectory, "inference-ownership", key);
  }

  get available(): boolean {
    return this.owned;
  }

  onLost(listener: () => void): void {
    this.lostListeners.add(listener);
  }

  async prepare(runtimeGeneration: string): Promise<NodeJS.ProcessEnv> {
    if (this.closed) throw new Error("Native inference ownership is closed.");
    this.owner ??= this.claim();
    await this.owner;
    await this.control(["--prepare", runtimeGeneration]);
    if (!this.owned || this.closed)
      throw new Error("Native inference ownership was lost.");
    return {
      CANTRIP_INFERENCE_SCOPE: this.directory,
      CANTRIP_INFERENCE_GENERATION: this.scope.workerGeneration,
      CANTRIP_INFERENCE_RUNTIME: runtimeGeneration,
    };
  }

  async retire(runtimeGeneration: string): Promise<void> {
    // A failed proof retains capacity and retries the actual operation. Killing
    // a stuck reconciliation helper cannot free a native execution's OS lease.
    let delayMs = 1_000;
    for (;;) {
      try {
        await this.control(["--retire", runtimeGeneration]);
        return;
      } catch (error) {
        this.report(error);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs).unref();
        });
        delayMs = Math.min(delayMs * 2, 30_000);
      }
    }
  }

  async journal(command: InferenceJournalCommand): Promise<unknown> {
    this.owner ??= this.claim();
    await this.owner;
    const child = this.keeper;
    if (!child || !this.owned || this.closed)
      throw new Error("Native inference journal has no live owner.");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.journalRequests.delete(requestId);
        // The keeper may finish a write after the observation deadline. A
        // caller must not dispatch inference without the matching durable ack.
        reject(
          new Error("Native inference journal acknowledgement timed out."),
        );
      }, 30_000);
      deadline.unref();
      this.journalRequests.set(requestId, { resolve, reject, deadline });
      child.stdin.write(
        JSON.stringify({ requestId, command }) + "\n",
        (error) => {
          if (!error) return;
          const pending = this.journalRequests.get(requestId);
          if (!pending) return;
          this.journalRequests.delete(requestId);
          clearTimeout(pending.deadline);
          pending.reject(error);
        },
      );
    });
  }

  private observeJournal(child: ChildProcessWithoutNullStreams): void {
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (buffer.length > 16 * 1_024 * 1_024) {
        // Malformed internal IPC revokes this keeper, never a native lease.
        child.kill("SIGKILL");
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let response: { requestId?: unknown; ok?: unknown; result?: unknown };
        try {
          response = JSON.parse(line) as typeof response;
        } catch {
          child.kill("SIGKILL");
          return;
        }
        if (typeof response.requestId !== "string") continue; // initial claim ack
        const pending = this.journalRequests.get(response.requestId);
        if (!pending) continue;
        this.journalRequests.delete(response.requestId);
        clearTimeout(pending.deadline);
        if (response.ok === true) pending.resolve(response.result);
        else
          pending.reject(
            new Error("Native inference journal operation failed."),
          );
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.owned = false;
    const child = this.keeper;
    if (!child) return;
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.stdin.end();
    });
    this.lostListeners.clear();
  }

  private launch(arguments_: string[]): ChildProcessWithoutNullStreams {
    // These helpers perform ownership operations only. They never invoke a model
    // and deliberately do not inherit any native runtime's registration.
    const environment = { ...process.env };
    delete environment.CANTRIP_INFERENCE_SCOPE;
    delete environment.CANTRIP_INFERENCE_GENERATION;
    delete environment.CANTRIP_INFERENCE_RUNTIME;
    return spawn(
      this.binary,
      [
        "cantrip-runtime-owner",
        "--scope",
        this.directory,
        "--generation",
        this.scope.workerGeneration,
        ...arguments_,
      ],
      { env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
  }

  private async claim(): Promise<void> {
    const child = this.launch([]);
    this.keeper = child;
    this.observeJournal(child);
    // Parent exit closes stdin even when abrupt. Unref the keeper's handles so
    // its lifetime pipe cannot keep an otherwise stopped Node worker alive.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr])
      (stream as Socket).unref();
    let ready = false;
    child.once("close", () => {
      this.owned = false;
      for (const pending of this.journalRequests.values()) {
        clearTimeout(pending.deadline);
        pending.reject(new Error("Native inference journal owner exited."));
      }
      this.journalRequests.clear();
      if (this.keeper === child) this.keeper = null;
      if (!ready) return;
      for (const listener of this.lostListeners) {
        try {
          listener();
        } catch (error) {
          this.report(error);
        }
      }
      if (!this.closed)
        this.report(new Error("Native inference ownership keeper exited."));
    });
    await this.acknowledgement(child, false);
    ready = true;
    // close may have overtaken the promise continuation.
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Native inference ownership keeper exited during claim.");
    if (this.closed)
      throw new Error("Native inference ownership closed during claim.");
    this.owned = true;
  }

  private async control(arguments_: string[]): Promise<void> {
    const child = this.launch(arguments_);
    child.stdin.end();
    await this.acknowledgement(child, true);
  }

  private acknowledgement(
    child: ChildProcessWithoutNullStreams,
    requireExit: boolean,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let output = "";
      let stderr = "";
      let acknowledged = false;
      let finished = false;
      let expired = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve();
      };
      const deadline = setTimeout(() => {
        expired = true;
        // Only this no-inference helper is killed. Await close; never interpret
        // the deadline or kill request as native-runtime settlement.
        child.kill("SIGKILL");
      }, 120_000);
      deadline.unref();
      child.stdin.on("error", (error) => this.report(error));
      child.stdout.on("error", (error) => {
        this.report(error);
        child.kill("SIGKILL");
      });
      child.stderr.on("error", (error) => {
        this.report(error);
        child.kill("SIGKILL");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-4_096);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (acknowledged || expired) return;
        output += chunk.toString("utf8");
        if (output.length > 4_096) {
          child.kill("SIGKILL");
          return;
        }
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        try {
          const ack = JSON.parse(output.slice(0, newline)) as {
            version?: unknown;
            generation?: unknown;
            ready?: unknown;
          };
          acknowledged =
            ack.version === 1 &&
            ack.generation === this.scope.workerGeneration &&
            ack.ready === true;
        } catch {
          // Invalid output is failure of the actual ownership operation.
        }
        if (!acknowledged) child.kill("SIGKILL");
        else if (!requireExit) finish();
      });
      child.once("error", (error) => {
        if (child.pid === undefined) finish(error);
        else this.report(error); // A failed signal does not establish death.
      });
      child.once("close", (code) => {
        if (expired || !acknowledged || code !== 0)
          finish(
            new Error(
              `Native ownership operation failed${expired ? " (deadline)" : ""}: ${stderr.trim() || `exit ${code}`}`,
            ),
          );
        else finish();
      });
    });
  }

  private report(error: unknown): void {
    try {
      this.onRecoveryError(error);
    } catch {
      // Diagnostics do not own the execution lifecycle.
    }
  }
}
