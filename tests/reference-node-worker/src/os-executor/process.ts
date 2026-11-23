import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  OsExecutorDeliveryError,
  type OsExecutorConnection,
} from "./connection.js";
import { guestFileUri } from "./paths.js";
import {
  evictedOutputAfter,
  type NativeOutputHistory,
} from "./output-history.js";

interface ProcessRead extends NativeOutputHistory {
  chunks: Array<{ seq: number; stream: string; chunk: string }>;
  nextSeq: number;
  exited: boolean;
  exitCode: number | null;
  closed: boolean;
  failure: string | null;
}

export class OsProcessOutcomeUnknownError extends OsExecutorDeliveryError {
  constructor(
    readonly processId: string,
    cause: unknown,
  ) {
    super(
      `Linux process ${processId} has an unknown outcome; observe its known native session before retrying.`,
    );
    this.cause = cause;
  }
}

export interface GuestProcessResult {
  processId: string;
  state: "exited";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  output: string;
  outputTruncated: boolean;
  outputCoverage: "reported" | "unavailable";
  terminationRequested: "cancelled" | "timeout" | "output-limit" | null;
  failure: string | null;
}

/** Finite administrative Git/provisioning commands use the pinned executor's
 * process API. The callback durably records the ID before dispatch. There is no
 * host spawn or automatic retry, including after uncertain start delivery. */
async function finiteGuestProcess(
  connection: OsExecutorConnection,
  argv: string[],
  cwd: string,
  options: {
    processId?: string;
    env?: Record<string, string>;
    stdin?: string;
    signal?: AbortSignal;
    maxDurationMs?: number;
    maxOutputBytes?: number;
    prepared?: (processId: string) => Promise<void>;
  } = {},
  observeOnly = false,
): Promise<GuestProcessResult> {
  const processId = options.processId ?? randomUUID();
  const uri = guestFileUri(cwd);
  options.signal?.throwIfAborted();
  if (!observeOnly) await options.prepared?.(processId);
  options.signal?.throwIfAborted();
  const deadline = Date.now() + (options.maxDurationMs ?? 30 * 60_000);
  const limit = options.maxOutputBytes ?? 4 * 1024 * 1024;
  const chunks: Array<{ stream: string; data: Buffer }> = [];
  let bytes = 0,
    afterSeq: number | null = null;
  let terminationRequested: GuestProcessResult["terminationRequested"] = null;
  let outputTruncated = false;
  let outputLimitExceeded = false;
  let coverageReported = true;
  let knownExited = false;
  let terminationDeadline: number | null = null;
  try {
    if (!observeOnly) {
      await connection.request("process/start", {
        processId,
        argv,
        cwd: uri,
        env: options.env ?? {},
        tty: false,
        pipeStdin: options.stdin !== undefined,
        arg0: null,
        sandbox: null,
      });
      if (options.stdin !== undefined) {
        const input = Buffer.from(options.stdin);
        for (let offset = 0; offset < input.length; offset += 32768) {
          const written = await connection.request<{ status: string }>(
            "process/write",
            {
              processId,
              writeId: randomUUID(),
              chunk: input.subarray(offset, offset + 32768).toString("base64"),
            },
          );
          if (written.status !== "accepted")
            throw new Error(
              "Linux process input delivery was not acknowledged.",
            );
        }
      }
    }
    for (;;) {
      const reason = options.signal?.aborted
        ? "cancelled"
        : Date.now() >= deadline
          ? "timeout"
          : outputLimitExceeded
            ? "output-limit"
            : null;
      if (observeOnly && reason)
        throw new Error(
          "Linux process observation reached its bound; the process was left running.",
        );
      if (
        reason &&
        terminationRequested === null &&
        (!knownExited || reason !== "output-limit")
      ) {
        terminationRequested = reason;
        await connection.request("process/terminate", { processId });
        terminationDeadline = Date.now() + 10_000;
      }
      const result = await connection.request<ProcessRead>("process/read", {
        processId,
        afterSeq,
        maxBytes: 65536,
        waitMs: 200,
      });
      knownExited = result.exited;
      coverageReported &&= result.outputEvictedThroughSeq != null;
      if (evictedOutputAfter(result, afterSeq) !== null) outputTruncated = true;
      for (const chunk of result.chunks) {
        const data = Buffer.from(chunk.chunk, "base64");
        if (bytes + data.length > limit) {
          outputTruncated = true;
          outputLimitExceeded = true;
        }
        const retained = data.subarray(0, Math.max(0, limit - bytes));
        bytes += retained.length;
        if (retained.length)
          chunks.push({ stream: chunk.stream, data: retained });
      }
      afterSeq = Math.max(0, result.nextSeq - 1);
      // Exit can be reported while maxBytes still leaves buffered output. Read
      // through the empty terminal page before returning a complete receipt.
      if (result.exited && result.closed && result.chunks.length === 0) {
        const decoders = new Map<string, StringDecoder>();
        let output = "";
        for (const chunk of chunks) {
          let decoder = decoders.get(chunk.stream);
          if (!decoder) {
            decoder = new StringDecoder("utf8");
            decoders.set(chunk.stream, decoder);
          }
          output += decoder.write(chunk.data);
        }
        for (const decoder of decoders.values()) output += decoder.end();
        const text = (stream?: string) =>
          Buffer.concat(
            chunks
              .filter((chunk) => !stream || chunk.stream === stream)
              .map((chunk) => chunk.data),
          ).toString("utf8");
        return {
          processId,
          state: "exited",
          exitCode: result.exitCode,
          stdout: text("stdout"),
          stderr: text("stderr"),
          output,
          outputTruncated,
          outputCoverage: coverageReported ? "reported" : "unavailable",
          terminationRequested,
          failure: result.failure,
        };
      }
      if ((result.closed && !result.exited) || result.failure)
        throw new Error("Native process closed without an observed exit.");
      if (terminationDeadline !== null && Date.now() >= terminationDeadline)
        throw new Error(
          "Native process did not close after termination was requested.",
        );
    }
  } catch (error) {
    throw new OsProcessOutcomeUnknownError(processId, error);
  }
}

export function runGuestProcess(
  connection: OsExecutorConnection,
  argv: string[],
  cwd: string,
  options: NonNullable<Parameters<typeof finiteGuestProcess>[3]> = {},
) {
  return finiteGuestProcess(connection, argv, cwd, options);
}

/** Observe a known native process. No start request or input is ever sent. */
export function observeGuestProcess(
  connection: OsExecutorConnection,
  processId: string,
) {
  return finiteGuestProcess(
    connection,
    [],
    "/",
    {
      processId,
      maxDurationMs: 180_000,
      maxOutputBytes: 8 * 1024 * 1024,
    },
    true,
  );
}
