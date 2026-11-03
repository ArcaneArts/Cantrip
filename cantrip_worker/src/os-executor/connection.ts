import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/** Guest locations are separate from the worker's local filesystem paths. */
export interface OsExecutorBinding {
  instance_id: string;
  generation: string;
  owner_id: string;
  worker_id: string;
  workspace_id: string;
  executor_generation: string;
  uid: number;
  home: string;
  url: string;
}

export type OsExecutorTransport =
  | { kind: "docker"; container: string }
  | {
      kind: "ssh";
      host: string;
      port: number;
      user: string;
      identityFile: string;
      knownHostsFile: string;
    };

export class OsExecutorDeliveryError extends Error {
  readonly delivery = "unknown";
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** SSH authenticates the carrier; Docker uses the owning worker's daemon access.
 * Neither transport copies model credentials or installs a worker in the guest. */
export function executorCommand(
  transport: OsExecutorTransport,
  args: string[],
): { command: string; args: string[] } {
  if (transport.kind === "docker")
    return {
      command: "docker",
      args: [
        "exec",
        "-i",
        "--user",
        "0",
        "--",
        transport.container,
        "cantrip-executor",
        ...args,
      ],
    };
  return {
    command: "ssh",
    args: [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      `UserKnownHostsFile=${transport.knownHostsFile}`,
      "-i",
      transport.identityFile,
      "-p",
      String(transport.port),
      "--",
      `${transport.user}@${transport.host}`,
      ["sudo", "-n", "--", "/usr/bin/cantrip-executor", ...args]
        .map(quote)
        .join(" "),
    ],
  };
}

export async function executorControl<T>(
  transport: OsExecutorTransport,
  args: string[],
): Promise<T> {
  const spec = executorCommand(transport, args);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      diagnostics = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new OsExecutorDeliveryError(
          "Executor control timed out; reconcile before retrying a mutation",
        ),
      );
    }, 60_000);
    child.stdin.end();
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
      if (output.length > 1_048_576) child.kill();
    });
    child.stderr.on("data", (data: Buffer) => {
      diagnostics = (diagnostics + data.toString()).slice(-4096);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(
          new OsExecutorDeliveryError(
            `Executor control exited ${code}: ${diagnostics}`,
          ),
        );
      else {
        try {
          resolve(JSON.parse(output) as T);
        } catch {
          reject(
            new OsExecutorDeliveryError(
              "Executor returned an invalid control receipt",
            ),
          );
        }
      }
    });
  });
}

/** Native exec-server JSON RPC over a protected carrier. Never retries requests.
 * Closing the carrier disconnects; process cancellation uses process/terminate.
 * The initialized native session ID can be explicitly resumed on a new carrier. */
export class OsExecutorConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<void>;
  private nextId = 1;
  private ended = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    transport: OsExecutorTransport,
    readonly binding: OsExecutorBinding,
    readonly notification: (method: string, params: unknown) => void = () => {},
  ) {
    const spec = executorCommand(transport, [
      "connect",
      binding.workspace_id,
      "--expect",
      JSON.stringify(binding),
    ]);
    this.child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.closed = new Promise((resolve) =>
      this.child.once("close", () => resolve()),
    );
    // Guest/SSH diagnostics must not fill a pipe and deadlock transport. Control
    // errors are intentionally generic here; stderr can include guest content.
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as {
          id?: number;
          result?: unknown;
          error?: { message: string };
          method?: string;
          params?: unknown;
        };
        if (message.id !== undefined) {
          const request = this.pending.get(message.id);
          if (!request) return;
          this.pending.delete(message.id);
          clearTimeout(request.timer);
          if (message.error) request.reject(new Error(message.error.message));
          else request.resolve(message.result);
        } else if (message.method)
          this.notification(message.method, message.params);
      } catch {
        this.fail(
          new OsExecutorDeliveryError(
            "Invalid executor frame; pending mutation outcomes are unknown",
          ),
        );
        this.child.kill();
      }
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", () =>
      this.fail(
        new OsExecutorDeliveryError(
          "Executor disconnected; reconcile known sessions before retrying",
        ),
      ),
    );
    this.child.stdin.on("error", () =>
      this.fail(
        new OsExecutorDeliveryError(
          "Executor transport write failed; delivery is unknown",
        ),
      ),
    );
  }

  private fail(error: Error): void {
    this.ended = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.ended)
      return Promise.reject(
        new OsExecutorDeliveryError("Executor transport is closed"),
      );
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new OsExecutorDeliveryError(
            "Executor request timed out; outcome is unknown and was not replayed",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  notify(method: string, params: unknown = null): void {
    if (this.ended)
      throw new OsExecutorDeliveryError("Executor transport is closed");
    this.child.stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  async close(): Promise<void> {
    this.fail(new OsExecutorDeliveryError("Executor carrier closed"));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 5000);
    try {
      await this.closed;
    } finally {
      clearTimeout(timer);
    }
  }
}
