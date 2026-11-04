/** Trusted Host PTY carrier. User commands are bytes delivered to the native
 * Linux PTY; this program never interprets them as a Host shell command. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { cantripOsExecutionSchema } from "@cantrip/protocol";
import { OsExecutorConnection } from "./connection.js";
import {
  durableTerminalJson,
  type OsTerminalDescriptor,
} from "./terminal-launcher.js";
import { guestFileUri } from "./paths.js";

interface NativeAdmission {
  identity: string;
  sessionId: string;
  processId: string;
  executorGeneration: string;
  exited?: {
    code: number | null;
    outcome?: "exited" | "interrupted" | "unknown";
  };
}
interface NativeRead {
  chunks: { seq: number; stream: string; chunk: string }[];
  nextSeq: number;
  exited: boolean;
  exitCode: number | null;
  closed: boolean;
  failure: string | null;
}
const filename = process.argv[2];
if (!filename) throw new Error("Missing authorized Linux terminal descriptor.");
const descriptor = JSON.parse(
  await readFile(filename, "utf8"),
) as OsTerminalDescriptor;
if (descriptor.version !== 1 || !/^[a-f0-9]{64}$/.test(descriptor.identity))
  throw new Error("Invalid Linux terminal descriptor.");
const execution = cantripOsExecutionSchema.parse(descriptor.execution);
const savedFile = path.join(path.dirname(filename), "native.json");
const connection = new OsExecutorConnection(
  execution.transport,
  descriptor.binding,
);
let saved: NativeAdmission | undefined;
let terminating = false;
let outputFinished = false;
let inputQueue = Promise.resolve();
let failure: unknown;
let outcome: "exited" | "interrupted" | "unknown" = "unknown";
process.stdin.pause();
process.stdin.setRawMode?.(true);
// Linux already supplies terminal CR/LF and escape sequences. Configure only
// this trusted carrier PTY; never interpret user bytes in a Host shell.
if (process.platform !== "win32" && process.stdin.isTTY)
  execFileSync("/bin/stty", ["-opost"], {
    stdio: ["inherit", "ignore", "ignore"],
  });

const dimensions = () => ({
  rows: process.stdout.rows || descriptor.rows,
  cols: process.stdout.columns || descriptor.cols,
});
const resize = async () => {
  if (saved && !outputFinished)
    await connection.request("process/resize", {
      processId: saved.processId,
      ...dimensions(),
    });
};
const terminate = () => {
  if (terminating) return;
  terminating = true;
  void (async () => {
    if (saved && !outputFinished)
      await connection.request("process/terminate", {
        processId: saved.processId,
      });
    else await connection.close();
  })().catch((cause) => {
    failure = cause;
    void connection.close();
  });
};
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
  process.on(signal, terminate);
process.on("SIGWINCH", () => {
  void resize().catch((cause) => {
    failure = cause;
    void connection.close();
  });
});

try {
  try {
    saved = JSON.parse(await readFile(savedFile, "utf8"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  if (
    saved &&
    (saved.identity !== descriptor.identity ||
      (!saved.exited &&
        saved.executorGeneration !== descriptor.binding.executor_generation))
  )
    throw new Error(
      "The previous Linux terminal has an unknown outcome on a different executor. It was not restarted.",
    );
  if (saved?.exited) {
    outcome =
      saved.exited.outcome ??
      (saved.exited.code === null ? "unknown" : "exited");
    process.exitCode = saved.exited.code ?? 198;
  } else {
    const initialized = await connection.request<{ sessionId: string }>(
      "initialize",
      {
        clientName: "cantrip-terminal",
        resumeSessionId: saved?.sessionId ?? null,
      },
    );
    connection.notify("initialized");
    if (saved && initialized.sessionId !== saved.sessionId)
      throw new Error(
        "The Linux terminal session changed; no replacement shell was started.",
      );
    if (!saved) {
      saved = {
        identity: descriptor.identity,
        sessionId: initialized.sessionId,
        processId: randomUUID(),
        executorGeneration: descriptor.binding.executor_generation,
      };
      // Exclusive durable admission precedes start. An uncertain start is only
      // observed on reconnect, never blindly sent a second time.
      await durableTerminalJson(savedFile, saved, true);
      await connection.request("process/start", {
        processId: saved.processId,
        argv: ["/bin/bash", "--login"],
        cwd: guestFileUri(descriptor.cwd),
        env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
        tty: true,
        arg0: null,
        sandbox: null,
      });
    }
    await resize();
    process.stdin.on("data", (data: Buffer) => {
      inputQueue = inputQueue.then(async () => {
        for (let offset = 0; offset < data.length; offset += 32768) {
          const written = await connection.request<{ status: string }>(
            "process/write",
            {
              processId: saved!.processId,
              writeId: randomUUID(),
              chunk: data.subarray(offset, offset + 32768).toString("base64"),
            },
          );
          if (written.status !== "accepted")
            throw new Error(
              "Linux terminal input was not acknowledged; it was not replayed.",
            );
        }
      });
      void inputQueue.catch((cause) => {
        failure = cause;
        void connection.close();
      });
    });
    process.stdin.on("end", terminate);
    process.stdin.resume();
    let afterSeq: number | null = null;
    for (;;) {
      const read: NativeRead = await connection.request("process/read", {
        processId: saved.processId,
        afterSeq,
        maxBytes: 65536,
        waitMs: 200,
      });
      afterSeq = Math.max(0, read.nextSeq - 1);
      for (const chunk of read.chunks) {
        if (!process.stdout.write(Buffer.from(chunk.chunk, "base64")))
          await once(process.stdout, "drain");
      }
      if (read.exited && read.closed && !read.chunks.length) {
        outputFinished = true;
        outcome = terminating
          ? "interrupted"
          : read.exitCode === null
            ? "unknown"
            : "exited";
        saved.exited = { code: read.exitCode, outcome };
        await durableTerminalJson(savedFile, saved);
        process.exitCode = terminating ? 197 : (read.exitCode ?? 198);
        break;
      }
    }
  }
} catch (cause) {
  failure = cause;
} finally {
  if (failure) outcome = "unknown";
  if (saved)
    await durableTerminalJson(
      path.join(path.dirname(filename), "outcome.json"),
      { identity: saved.identity, processId: saved.processId, state: outcome },
    ).catch(() => {});
  process.stdin.pause();
  process.stdin.setRawMode?.(false);
  await connection.close();
}
if (failure) {
  process.stderr.write(
    "\r\nLinux terminal disconnected; the command outcome is unknown and input was not replayed.\r\n",
  );
  process.exitCode = 198;
}
