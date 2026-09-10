import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { NativeRuntimeHandoffState } from "@cantrip/protocol";
import type {
  ManagedHistoryExport,
  ManagedHistoryImport,
} from "./managed-history-transfer.js";
import type { ManagedRuntimeNamespaceScope } from "./managed-runtime-namespaces.js";
import {
  ensureHistoryDirectory,
  writeImmutableHistoryFile,
  serializeHistoryOperation,
} from "../native-history-outbox-files.js";

const id = z.string().min(1);
const absolutePath = z.string().refine(path.isAbsolute);
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
    previousOperationId: z.string().uuid().nullable(),
  })
  .strict();
export type ManagedRuntimeHandoffPlan = z.infer<typeof planSchema>;
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
          plan.sourceBindingId !== state.source.bindingId
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
          expectedLastTurnId: plan.expectedLastTurnId,
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
