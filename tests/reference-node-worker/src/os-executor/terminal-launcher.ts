import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cantripOsExecutionSchema,
  type CantripOsExecution,
} from "@cantrip/protocol";
import type { CantripOsController } from "./controller.js";
import { OsExecutorConnection, type OsExecutorBinding } from "./connection.js";

export interface OsTerminalLaunch {
  type: "os-shell";
  configurationFile: string;
}
export interface OsTerminalDescriptor {
  version: 1;
  terminalId: string;
  identity: string;
  execution: CantripOsExecution;
  binding: OsExecutorBinding;
  cwd: string;
  cols: number;
  rows: number;
}

export async function durableTerminalJson(
  filename: string,
  value: unknown,
  exclusive = false,
) {
  const temporary = exclusive ? filename : `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporary, exclusive ? "wx" : "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  if (!exclusive) await rename(temporary, filename);
  const directory = await open(path.dirname(filename), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Only a trusted carrier is local. Its cwd is Worker-private; the user shell
 * and all its input execute in the captured Linux process. */
export class OsTerminalLauncher {
  constructor(
    private readonly directory: string,
    private readonly controller: Pick<
      CantripOsController,
      "captureExecutionBinding"
    >,
    private readonly authority: { ownerId(): string; serverIdentity(): string },
  ) {}
  private indexFile(terminalId: string) {
    const id = createHash("sha256")
      .update(
        JSON.stringify({
          terminalId,
          owner: this.authority.ownerId(),
          server: this.authority.serverIdentity(),
        }),
      )
      .digest("hex");
    return path.join(
      this.directory,
      "os-terminal-carriers",
      "index",
      `${id}.json`,
    );
  }

  /** Close an admitted Linux process after a Worker restart, even when no local
   * PTY survives. Never create or start a replacement process during cleanup. */
  async close(terminalId: string): Promise<void> {
    let index: { identity: string };
    try {
      index = JSON.parse(await readFile(this.indexFile(terminalId), "utf8"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    if (!/^[a-f0-9]{64}$/.test(index.identity))
      throw new Error("Invalid Linux terminal cleanup identity.");
    const directory = path.join(
      this.directory,
      "os-terminal-carriers",
      index.identity,
    );
    const descriptor = JSON.parse(
      await readFile(path.join(directory, "descriptor.json"), "utf8"),
    ) as OsTerminalDescriptor;
    if (
      descriptor.identity !== index.identity ||
      descriptor.terminalId !== terminalId ||
      descriptor.execution.scope.ownerId !== this.authority.ownerId()
    )
      throw new Error("Linux terminal cleanup authority changed.");
    let admitted: {
      identity: string;
      processId: string;
      sessionId: string;
      executorGeneration: string;
      exited?: { code: number | null; outcome?: string };
    };
    try {
      admitted = JSON.parse(
        await readFile(path.join(directory, "native.json"), "utf8"),
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    if (admitted.identity !== descriptor.identity)
      throw new Error("Linux terminal cleanup outcome is unknown.");
    if (admitted.exited) return;
    if (admitted.executorGeneration !== descriptor.binding.executor_generation)
      throw new Error("Linux terminal cleanup outcome is unknown.");
    const connection = new OsExecutorConnection(
      descriptor.execution.transport,
      descriptor.binding,
    );
    try {
      const initialized = await connection.request<{ sessionId: string }>(
        "initialize",
        {
          clientName: "cantrip-terminal-close",
          resumeSessionId: admitted.sessionId,
        },
      );
      connection.notify("initialized");
      if (initialized.sessionId !== admitted.sessionId)
        throw new Error(
          "Linux terminal session changed; no process was replaced.",
        );
      await connection.request("process/terminate", {
        processId: admitted.processId,
      });
      const deadline = Date.now() + 10_000;
      for (;;) {
        const result = await connection.request<{
          exited: boolean;
          closed: boolean;
          exitCode: number | null;
        }>("process/read", {
          processId: admitted.processId,
          afterSeq: null,
          maxBytes: 65536,
          waitMs: 200,
        });
        if (result.exited && result.closed) {
          admitted.exited = { code: result.exitCode, outcome: "interrupted" };
          await durableTerminalJson(
            path.join(directory, "native.json"),
            admitted,
          );
          await durableTerminalJson(path.join(directory, "outcome.json"), {
            identity: admitted.identity,
            processId: admitted.processId,
            state: "interrupted",
          });
          return;
        }
        if (Date.now() >= deadline)
          throw new Error("Linux terminal termination outcome is unknown.");
      }
    } finally {
      await connection.close();
    }
  }

  async prepare(
    terminalId: string,
    supplied: CantripOsExecution,
    cwd: string,
    cols: number,
    rows: number,
    serverId: string,
  ) {
    const execution = cantripOsExecutionSchema.parse(supplied);
    if (
      execution.scope.ownerId !== this.authority.ownerId() ||
      serverId !== this.authority.serverIdentity()
    )
      throw new Error(
        "The Linux terminal belongs to another account or server.",
      );
    const root = execution.scope.guestPath;
    const relative = path.posix.relative(root, cwd);
    if (
      !path.posix.isAbsolute(cwd) ||
      relative === ".." ||
      relative.startsWith("../") ||
      path.posix.isAbsolute(relative)
    )
      throw new Error(
        "The Linux terminal directory escapes its captured worktree.",
      );
    const binding = await this.controller.captureExecutionBinding(
      execution.transport,
      { ...execution.scope, serverId },
    );
    const identity = createHash("sha256")
      .update(JSON.stringify({ terminalId, execution, cwd, serverId }))
      .digest("hex");
    const local = path.join(this.directory, "os-terminal-carriers", identity);
    await mkdir(local, { recursive: true, mode: 0o700 });
    const configurationFile = path.join(local, "descriptor.json");
    const descriptor: OsTerminalDescriptor = {
      version: 1,
      terminalId,
      identity,
      execution,
      binding,
      cwd,
      cols,
      rows,
    };
    const index = path.dirname(this.indexFile(terminalId));
    await mkdir(index, { recursive: true, mode: 0o700 });
    try {
      await durableTerminalJson(this.indexFile(terminalId), { identity }, true);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const captured = JSON.parse(
        await readFile(this.indexFile(terminalId), "utf8"),
      );
      if (captured.identity !== identity)
        throw new Error(
          "The terminal's captured source or directory changed. Create a new terminal.",
        );
    }
    await durableTerminalJson(configurationFile, descriptor);
    return {
      cwd: local,
      launch: { type: "os-shell", configurationFile } as OsTerminalLaunch,
    };
  }
}

export function osTerminalBridgeCommand(launch: OsTerminalLaunch) {
  const filename = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./terminal-bridge.ts"
        : "./terminal-bridge.js",
      import.meta.url,
    ),
  );
  return {
    command: process.execPath,
    args: [
      ...(import.meta.url.endsWith(".ts")
        ? ["--import", import.meta.resolve("tsx")]
        : []),
      filename,
      launch.configurationFile,
    ],
  };
}

/** A carrier exit is distinct from the Linux command's outcome. In particular a
 * legitimate `exit 198` is still exited when the peer saved its completion. */
export function osTerminalOutcome(
  launch: OsTerminalLaunch,
): "exited" | "interrupted" | "unknown" {
  try {
    const directory = path.dirname(launch.configurationFile);
    const saved = JSON.parse(
      readFileSync(path.join(directory, "native.json"), "utf8"),
    );
    const outcome = JSON.parse(
      readFileSync(path.join(directory, "outcome.json"), "utf8"),
    );
    if (
      saved.identity === outcome.identity &&
      saved.processId === outcome.processId &&
      ["exited", "interrupted", "unknown"].includes(outcome.state)
    )
      return outcome.state;
  } catch {
    /* A missing/torn receipt cannot establish completion. */
  }
  return "unknown";
}
