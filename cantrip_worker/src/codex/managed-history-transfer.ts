import path from "node:path";
import { z } from "zod";

const identity = z.string().min(1);
const exportSchema = z
  .object({
    threadId: identity,
    transferId: z.string().uuid(),
    expectedLastTurnId: identity.nullable(),
    expectedGoalEpoch: identity.optional(),
    expectedHandoffOperation: z.string().uuid().optional(),
  })
  .strict();
const importSchema = z
  .object({
    threadId: identity,
    transferId: z.string().uuid(),
    path: z
      .string()
      .refine(
        path.isAbsolute,
        "Expected a worker-local absolute artifact path",
      ),
  })
  .strict();
const receiptSchema = z.object({
  threadId: identity,
  path: z
    .string()
    .refine(path.isAbsolute, "Expected a native absolute artifact path"),
});
export type ManagedHistoryExport = z.infer<typeof exportSchema>;
export type ManagedHistoryImport = z.infer<typeof importSchema>;

/** Calls the actual native idle/storage operation. A transport change makes its
 * outcome uncertain; the caller must reconcile using the same transfer ID. */
export async function requestManagedHistoryTransfer(
  request: (method: string, params: unknown) => Promise<unknown>,
  generation: () => unknown,
  method: "thread/managedHistory/export" | "thread/managedHistory/import",
  value: unknown,
  signal?: AbortSignal,
) {
  const params = (
    method === "thread/managedHistory/export" ? exportSchema : importSchema
  ).parse(value);
  signal?.throwIfAborted();
  const before = generation();
  const pending = request(method, params);
  // Stop observing promptly on cancellation. This is not proof that native I/O
  // stopped: the export's exact root-hold fence prevents a late seal/publication
  // from becoming another transfer's authority, and the coordinator reconciles
  // the same immutable transfer identity.
  let abort: (() => void) | undefined;
  const response = await (signal
    ? new Promise<unknown>((resolve, reject) => {
        abort = () =>
          reject(
            signal.reason ??
              new Error("Native history transfer observation was cancelled."),
          );
        signal.addEventListener("abort", abort, { once: true });
        pending.then(resolve, reject);
        if (signal.aborted) abort();
      }).finally(() => {
        if (abort) signal.removeEventListener("abort", abort);
      })
    : pending);
  signal?.throwIfAborted();
  if (generation() !== before)
    throw new Error(
      "The native transport changed during history transfer; reconcile the same transfer ID.",
    );
  const receipt = receiptSchema.parse(response);
  if (receipt.threadId !== params.threadId)
    throw new Error("Native history transfer returned another conversation.");
  return receipt;
}
