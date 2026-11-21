import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import type { TunnelStreamSocket } from "../tunnel-tcp-adapter.js";
import {
  remoteCommand,
  remoteControl,
  type OsExecutorTransport,
} from "./connection.js";

/** A real guest service stream; it never opens a host loopback destination. */
export class OsServiceStream extends Duplex implements TunnelStreamSocket {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly connectionId = randomUUID();
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private readonly readiness: Promise<void>;
  private confirmed = false;
  private resolveRetired!: () => void;
  private rejectRetired!: (error: unknown) => void;
  private readonly retired = new Promise<void>((resolve, reject) => {
    this.resolveRetired = resolve;
    this.rejectRetired = reject;
  });

  constructor(
    private readonly transport: OsExecutorTransport,
    private readonly workspace: string,
    private readonly descriptor: Record<string, unknown>,
    publicKey?: string,
  ) {
    super({ allowHalfOpen: true, highWaterMark: 65_536 });
    const spec = remoteCommand(transport, [
      "service-connect",
      workspace,
      "--expect",
      JSON.stringify(descriptor),
      "--connection-id",
      this.connectionId,
      "--notify-ready",
      ...(publicKey ? ["--public-key", publicKey] : []),
    ]);
    this.child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.pause();
    void this.retired.catch(() => {});
    this.on("error", () => {}); // The preparing caller owns errors before handoff.
    this.readiness = new Promise<void>((resolve, reject) => {
      let text = "",
        ready = false;
      const timer = setTimeout(
        () =>
          reject(
            new Error("The guest service connection did not become ready."),
          ),
        35_000,
      );
      const ended = () => {
        clearTimeout(timer);
        if (!ready)
          reject(
            new Error(
              "The guest service connection ended before its readiness receipt.",
            ),
          );
      };
      this.child.stderr.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        let end: number;
        while ((end = text.indexOf("\n")) !== -1) {
          const line = text.slice(0, end).trim();
          text = text.slice(end + 1);
          if (
            !ready &&
            line === `CANTRIP_OS_SERVICE_READY ${this.connectionId}`
          ) {
            ready = true;
            clearTimeout(timer);
            resolve();
          }
        }
        text = text.slice(-4_096);
      });
      this.child.once("error", (error) => {
        ended();
        reject(error);
        this.destroy(error);
      });
      this.child.once("close", (code) => {
        ended();
        if (code !== 0 && !this.destroyed)
          this.destroy(new Error("The guest service carrier failed."));
      });
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) this.child.stdout.pause();
    });
    this.child.stdout.once("end", () => this.push(null));
    this.child.stdout.on("error", (error) => this.destroy(error));
    this.child.stdin.on("error", (error) => this.destroy(error));
  }

  async ready() {
    try {
      await this.readiness;
    } catch (error) {
      this.destroy();
      throw error;
    }
    if (this.destroyed)
      throw new Error("The guest service stream was retired while opening.");
    return this;
  }

  override _read() {
    this.child.stdout.resume();
  }
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.child.stdin.write(chunk, callback);
  }
  override _final(callback: (error?: Error | null) => void) {
    this.child.stdin.end(callback);
  }
  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ) {
    if (this.timeout) clearTimeout(this.timeout);
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    void this.closeRemote()
      .then(
        () => {
          this.resolveRetired();
          callback(error);
        },
        (cleanupError) => {
          this.rejectRetired(cleanupError);
          callback(error ?? cleanupError);
        },
      )
      .finally(() => this.child.kill());
  }
  private async closeRemote() {
    if (this.confirmed) return;
    const result = await remoteControl<{ status: string }>(this.transport, [
      "service-close",
      this.workspace,
      "--expect",
      JSON.stringify(this.descriptor),
      "--connection-id",
      this.connectionId,
    ]);
    if (result.status !== "closed")
      throw new Error("Guest service cleanup was not confirmed.");
    this.confirmed = true;
  }
  async confirmRetired() {
    this.destroy();
    if (this.confirmed) return;
    try {
      await this.retired;
    } catch {
      await this.closeRemote();
    }
  }

  setNoDelay() {
    return this;
  }
  setTimeout(milliseconds: number) {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout =
      milliseconds > 0
        ? setTimeout(() => this.emit("timeout"), milliseconds)
        : undefined;
    return this;
  }
}
