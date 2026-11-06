import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  recoveryCommand,
  OsExecutorDeliveryError,
  type OsExecutorTransport,
} from "./connection.js";

export const recoveryGuestRecordSchema = z
  .object({
    version: z.literal(1),
    operation_id: z.string().uuid(),
    action: z.enum(["capture", "restore", "rollback"]),
    state: z.enum([
      "admitted",
      "capturing",
      "captured",
      "receiving",
      "received",
      "restoring",
      "restored",
      "rolled-back",
      "failed",
      "forgotten",
      "unknown",
    ]),
    receipt: z.record(z.string(), z.unknown()).nullable(),
    error: z.string().nullable(),
    maintenance: z.record(z.string(), z.unknown()).nullable(),
    active: z.boolean(),
  })
  .strict();

export type RecoveryGuestRecord = z.infer<typeof recoveryGuestRecordSchema>;

function carrier(
  transport: OsExecutorTransport,
  args: string[],
  signal?: AbortSignal,
) {
  const spec = recoveryCommand(transport, args);
  const child = spawn(spec.command, spec.args, {
    stdio: ["pipe", "pipe", "pipe"],
    signal,
  });
  child.stdin.on("error", () => {}); // The exit receipt/pipeline owns delivery errors.
  let diagnostics = "";
  child.stderr.on("data", (data: Buffer) => {
    diagnostics = (diagnostics + data.toString()).slice(-4096);
  });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", () =>
      reject(
        new OsExecutorDeliveryError(
          "The recovery carrier failed; observe the saved operation before retrying a mutation.",
        ),
      ),
    );
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new OsExecutorDeliveryError(
            `Recovery carrier exited ${code}: ${diagnostics}`,
          ),
        );
    });
  });
  // The stream consumer still awaits this exact result. Consume an early
  // rejection until its stdout iterator/pipeline has finished closing.
  void completed.catch(() => {});
  return { child, completed };
}

function stopCarrier(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  child.stdin.destroy();
  child.stdout.destroy();
}

/** No mutation retries and no generic short control timeout. The optional root
 * command journals its own lifetime; a lost carrier requires inspect/recover. */
export async function recoveryControl(input: {
  transport: OsExecutorTransport;
  args: string[];
  input?: AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
}): Promise<RecoveryGuestRecord> {
  const { child, completed } = carrier(
    input.transport,
    input.args,
    input.signal,
  );
  const sending = input.input
    ? pipeline(Readable.from(input.input), child.stdin)
    : Promise.resolve(child.stdin.end());
  void sending.catch(() => {});
  try {
    const parts: Buffer[] = [];
    let length = 0;
    for await (const value of child.stdout) {
      const part = value as Buffer;
      length += part.length;
      if (length > 32 * 1_048_576)
        throw new OsExecutorDeliveryError(
          "The recovery receipt is too large; observe the saved operation.",
        );
      parts.push(part);
    }
    await Promise.all([completed, sending]);
    return recoveryGuestRecordSchema.parse(
      JSON.parse(Buffer.concat(parts, length).toString("utf8")),
    );
  } finally {
    stopCarrier(child);
  }
}

/** Binary archive transfer bypasses native process/output retention. It is
 * read-only and succeeds only after the actual exporter exits successfully. */
export async function* exportRecoveryArchive(input: {
  transport: OsExecutorTransport;
  args: string[];
  signal?: AbortSignal;
}): AsyncGenerator<Uint8Array> {
  const { child, completed } = carrier(
    input.transport,
    input.args,
    input.signal,
  );
  child.stdin.end();
  try {
    for await (const value of child.stdout) yield value as Buffer;
    await completed;
  } finally {
    stopCarrier(child);
  }
}
