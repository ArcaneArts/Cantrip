import { createHash } from "node:crypto";
import { readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  inferenceJournalRecordSchema,
  type InferenceJournalRecord,
  type NativeRuntimeHandoffState,
  nativeGoalRecoverySourceSchema,
  nativeGoalRecoveryWithdrawalSchema,
  type NativeGoalRecoveryWithdrawal,
} from "@cantrip/protocol";
import type {
  ManagedHistoryExport,
  ManagedHistoryImport,
} from "./managed-history-transfer.js";
import type { ManagedRuntimeNamespaceScope } from "./managed-runtime-namespaces.js";
import {
  ensureHistoryDirectory,
  writeImmutableHistoryFile,
  serializeHistoryOperation,
  flushHistoryDirectory,
} from "../native-history-outbox-files.js";

const id = z.string().min(1);
const absolutePath = z.string().refine(path.isAbsolute);
const withdrawalSchema = z
  .object({
    version: z.literal(1),
    scope: z.object({ serverId: id, ownerId: id, workerId: id }).strict(),
    chatId: id,
    operationId: z.string().uuid(),
    sourceBindingId: id,
    sourceOperationId: id,
    sourceOperationGeneration: id,
    record: inferenceJournalRecordSchema,
  })
  .strict();
const goalWithdrawalSchema = withdrawalSchema
  .omit({ record: true })
  .extend({
    source: nativeGoalRecoverySourceSchema,
    receipt: nativeGoalRecoveryWithdrawalSchema,
  })
  .strict();
const planSchema = z
  .object({
    version: z.literal(1),
    scope: z.object({ serverId: id, ownerId: id, workerId: id }).strict(),
    chatId: id,
    threadId: id,
    operationId: z.string().uuid(),
    sourceBindingId: id,
    sourceHome: absolutePath,
    expectedLastTurnId: id.nullable(),
    expectedGoalEpoch: id.optional(),
    previousOperationId: z.string().uuid().nullable(),
  })
  .strict();
export type ManagedRuntimeHandoffPlan = z.infer<typeof planSchema>;

/** The immutable Source determines this expectation, never a later UI read or
 * a newly resumed Goal. Progress accounting does not change the native epoch. */
function sourceGoalEpoch(state: NativeRuntimeHandoffState) {
  const source = state.queuedSource;
  return (
    source?.taskGoal?.identity.recovery?.taskGoalCycle?.goalEpoch ??
    source?.goalRecovery?.goalEpoch ??
    source?.goalClaim?.goalEpoch ??
    source?.autonomousAttempt?.goalEpoch
  );
}
const receiptSchema = z
  .object({
    version: z.literal(1),
    threadId: id,
    transferId: z.string().uuid(),
    path: absolutePath,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
async function readOptional(filename: string): Promise<Buffer | null> {
  try {
    return await readFile(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Private worker recovery journal. It contains identity/boundaries and artifact
 * digests, never credentials, prompts or copied runtime configuration. The
 * original export is reusable even if its native RPC response was lost. */
export class ManagedRuntimeHandoffJournal {
  constructor(
    private readonly directory: string,
    private readonly scope: ManagedRuntimeNamespaceScope,
  ) {}

  private root(chatId: string, operationId: string) {
    id.parse(chatId);
    z.string().uuid().parse(operationId);
    return path.join(
      this.directory,
      "managed-runtime-handoffs",
      digest(
        JSON.stringify([
          this.scope.serverId,
          this.scope.ownerId,
          this.scope.workerId,
          chatId,
        ]),
      ),
      operationId,
    );
  }

  async withdrawal(
    state: NativeRuntimeHandoffState,
    capture: () => Promise<InferenceJournalRecord | null>,
  ): Promise<InferenceJournalRecord | null> {
    const source = state.queuedSource;
    if (!source || state.workerId !== this.scope.workerId)
      throw new Error("The handoff has no queued source for this worker.");
    const root = this.root(state.chatId, state.operationId);
    return serializeHistoryOperation(root, async () => {
      const filename = path.join(root, "withdrawal.json");
      const identity = {
        version: 1 as const,
        scope: this.scope,
        chatId: state.chatId,
        operationId: state.operationId,
        sourceBindingId: state.source.bindingId,
        sourceOperationId: source.operationId,
        sourceOperationGeneration: source.operationGeneration,
      };
      const existing = await readOptional(filename);
      if (existing) {
        const { record, ...stored } = withdrawalSchema.parse(
          JSON.parse(existing.toString("utf8")),
        );
        if (!isDeepStrictEqual(stored, identity))
          throw new Error("The handoff withdrawal reservation changed.");
        return record;
      }
      const record = await capture();
      if (!record) return null;
      const value = withdrawalSchema.parse({ ...identity, record });
      await ensureHistoryDirectory(root);
      await this.publish(filename, value);
      return value.record;
    });
  }

  async goalWithdrawal(
    state: NativeRuntimeHandoffState,
    capture: () => Promise<NativeGoalRecoveryWithdrawal>,
  ): Promise<NativeGoalRecoveryWithdrawal> {
    const source = state.queuedSource;
    if (!source?.goalRecovery || state.workerId !== this.scope.workerId)
      throw new Error(
        "The handoff has no recovered Goal source for this worker.",
      );
    const root = this.root(state.chatId, state.operationId);
    return serializeHistoryOperation(root, async () => {
      const filename = path.join(root, "goal-withdrawal.json");
      const identity = {
        version: 1 as const,
        scope: this.scope,
        chatId: state.chatId,
        operationId: state.operationId,
        sourceBindingId: state.source.bindingId,
        sourceOperationId: source.operationId,
        sourceOperationGeneration: source.operationGeneration,
        source: source.goalRecovery,
      };
      const existing = await readOptional(filename);
      if (existing) {
        const { receipt, ...stored } = goalWithdrawalSchema.parse(
          JSON.parse(existing.toString("utf8")),
        );
        if (!isDeepStrictEqual(stored, identity))
          throw new Error("The Goal withdrawal reservation changed.");
        const current = state.binding ?? state.source;
        if (
          receipt.bindingId === current.bindingId &&
          receipt.runtimeGeneration === current.runtimeGeneration
        )
          return receipt;
        // The canonical source binding was actually replaced. Retire only its
        // obsolete ACK, then capture a new native fence for that replacement.
        await rm(filename);
        await flushHistoryDirectory(root);
      }
      const receipt = await capture();
      if (
        receipt.operationId !== state.operationId ||
        !isDeepStrictEqual(receipt.source, source.goalRecovery)
      )
        throw new Error("Native Goal transfer fence returned another source.");
      const value = goalWithdrawalSchema.parse({ ...identity, receipt });
      await ensureHistoryDirectory(root);
      await this.publish(filename, value);
      return value.receipt;
    });
  }

  async retireWithdrawal(state: NativeRuntimeHandoffState): Promise<void> {
    if (!state.queuedSource?.withdrawn) return;
    if (
      !["completed", "cancelled"].includes(state.phase) ||
      state.workerId !== this.scope.workerId
    )
      throw new Error(
        "Withdrawal metadata still belongs to a pending handoff.",
      );
    const root = this.root(state.chatId, state.operationId);
    await serializeHistoryOperation(root, async () => {
      for (const [name, schema] of [
        ["withdrawal.json", withdrawalSchema],
        ["goal-withdrawal.json", goalWithdrawalSchema],
      ] as const) {
        const filename = path.join(root, name);
        const bytes = await readOptional(filename);
        if (!bytes) continue;
        const value = schema.parse(JSON.parse(bytes.toString("utf8")));
        if (
          !isDeepStrictEqual(value.scope, this.scope) ||
          value.chatId !== state.chatId ||
          value.operationId !== state.operationId ||
          value.sourceBindingId !== state.source.bindingId ||
          value.sourceOperationId !== state.queuedSource!.operationId ||
          value.sourceOperationGeneration !==
            state.queuedSource!.operationGeneration
        )
          throw new Error("Withdrawal metadata belongs to another handoff.");
        await rm(filename, { force: true });
        await flushHistoryDirectory(root);
      }
    });
  }

  async prepare(
    state: NativeRuntimeHandoffState,
    capture: () => Promise<
      Pick<
        ManagedRuntimeHandoffPlan,
        "sourceHome" | "expectedLastTurnId" | "previousOperationId"
      >
    >,
  ): Promise<ManagedRuntimeHandoffPlan> {
    if (
      state.workerId !== this.scope.workerId ||
      state.source.chatId !== state.chatId
    )
      throw new Error("Handoff journal belongs to another worker or chat.");
    const root = this.root(state.chatId, state.operationId);
    return serializeHistoryOperation(root, async () => {
      const existing = await readOptional(path.join(root, "plan.json"));
      if (existing) {
        const plan = planSchema.parse(JSON.parse(existing.toString("utf8")));
        if (
          !isDeepStrictEqual(plan.scope, this.scope) ||
          plan.chatId !== state.chatId ||
          plan.threadId !== state.source.threadId ||
          plan.operationId !== state.operationId ||
          plan.sourceBindingId !== state.source.bindingId ||
          // Task private transfer was introduced with the exact Goal boundary.
          // Older managed-agent journals remain readable without that field.
          (state.queuedSource?.taskGoal !== undefined &&
            plan.expectedGoalEpoch !== sourceGoalEpoch(state)) ||
          (plan.expectedGoalEpoch !== undefined &&
            plan.expectedGoalEpoch !== sourceGoalEpoch(state))
        )
          throw new Error("Handoff journal reservation changed.");
        return plan;
      }
      // After commit, absence of the source plan is a storage error. Do not
      // create a new transfer from whichever runtime happens to be current.
      if (!["preparing", "prepared"].includes(state.phase))
        throw new Error("Committed handoff has no worker export plan.");
      const plan = planSchema.parse({
        version: 1,
        scope: this.scope,
        chatId: state.chatId,
        threadId: state.source.threadId,
        operationId: state.operationId,
        sourceBindingId: state.source.bindingId,
        ...(await capture()),
        ...(sourceGoalEpoch(state)
          ? { expectedGoalEpoch: sourceGoalEpoch(state) }
          : {}),
      });
      await ensureHistoryDirectory(root);
      await this.publish(path.join(root, "plan.json"), plan);
      return plan;
    });
  }

  async export(
    value: ManagedRuntimeHandoffPlan,
    exporter: (
      input: ManagedHistoryExport,
    ) => Promise<{ threadId: string; path: string }>,
  ): Promise<ManagedHistoryImport> {
    const plan = planSchema.parse(value);
    if (!isDeepStrictEqual(plan.scope, this.scope))
      throw new Error("Foreign handoff journal scope.");
    const root = this.root(plan.chatId, plan.operationId);
    return serializeHistoryOperation(root, async () => {
      const persisted = await readOptional(path.join(root, "plan.json"));
      if (
        !persisted ||
        !isDeepStrictEqual(JSON.parse(persisted.toString("utf8")), plan)
      )
        throw new Error(
          "Handoff export requires its persisted reservation plan.",
        );
      const filename = path.join(
        plan.sourceHome,
        "managed-history-exports",
        `${plan.operationId}.json`,
      );
      const receiptPath = path.join(root, "export.json");
      const priorReceipt = await readOptional(receiptPath);
      let bytes = await readOptional(filename);
      if (!bytes) {
        if (priorReceipt)
          throw new Error("Committed handoff export is missing.");
        const result = await exporter({
          threadId: plan.threadId,
          transferId: plan.operationId,
          expectedHandoffOperation: plan.operationId,
          expectedLastTurnId: plan.expectedLastTurnId,
          ...(plan.expectedGoalEpoch
            ? { expectedGoalEpoch: plan.expectedGoalEpoch }
            : {}),
        });
        if (
          result.threadId !== plan.threadId ||
          (await realpath(result.path)) !== (await realpath(filename))
        )
          throw new Error("Native export returned another handoff artifact.");
        bytes = await readFile(filename);
      }
      // Native import validates all segment/state details. Here verify the
      // actual published artifact identity before acknowledging its receipt.
      const artifact = z
        .object({
          version: z.literal(2),
          thread_id: id,
          metadata: z.object({ id }),
        })
        .parse(JSON.parse(bytes.toString("utf8")));
      if (
        artifact.thread_id !== plan.threadId ||
        artifact.metadata.id !== plan.threadId
      )
        throw new Error("Native export contains another conversation.");
      const receipt = receiptSchema.parse({
        version: 1,
        threadId: plan.threadId,
        transferId: plan.operationId,
        path: filename,
        sha256: digest(bytes),
      });
      if (
        priorReceipt &&
        !isDeepStrictEqual(
          receiptSchema.parse(JSON.parse(priorReceipt.toString("utf8"))),
          receipt,
        )
      )
        throw new Error("Committed handoff artifact changed.");
      await this.publish(receiptPath, receipt);
      return {
        threadId: receipt.threadId,
        transferId: receipt.transferId,
        path: receipt.path,
      };
    });
  }

  private async publish(filename: string, value: unknown) {
    if (!(await writeImmutableHistoryFile(filename, JSON.stringify(value)))) {
      if (
        !isDeepStrictEqual(
          JSON.parse((await readFile(filename)).toString("utf8")),
          value,
        )
      )
        throw new Error("Conflicting handoff journal publication.");
    }
  }
}
