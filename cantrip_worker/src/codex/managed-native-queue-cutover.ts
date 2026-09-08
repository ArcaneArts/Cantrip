import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ManagedQueueImportResult,
  ManagedQueueSnapshot,
  NativeCommandSession,
} from "@cantrip/protocol";
import type { CodexAppServer } from "./app-server.js";
import type { ManagedNativeGatewayIdentity } from "./managed-native-gateway.js";
import type {
  ManagedNativeQueuePreparedPrompt,
  ManagedNativeQueuePromptInput,
} from "./managed-native-queue.js";
import type { ManagedNativeQueueClient } from "../managed-native-queue-client.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import {
  openNativeCommandContent,
  protectNativeCommandContent,
} from "../native-command-content.js";

const sourceSchema = z
  .object({
    id: z.string(),
    input: z.array(z.record(z.string(), z.unknown())),
    clientUserMessageId: z.string(),
  })
  .strict();
export interface ManagedNativeQueueCutoverOptions {
  identity: ManagedNativeGatewayIdentity;
  session(): NativeCommandSession;
  runnerGeneration(): string;
  signal(): AbortSignal;
  assertCurrent(): void;
  runtime: Pick<
    CodexAppServer,
    "readManagedNativeQueue" | "deleteManagedNativeQueue"
  >;
  client: Pick<ManagedNativeQueueClient, "import" | "acknowledgeImport">;
  encryption: Pick<
    WorkerEncryptionService,
    "ownerId" | "serverIdentity" | "componentKey"
  >;
  preparePrompt(
    input: ManagedNativeQueuePromptInput,
  ): Promise<ManagedNativeQueuePreparedPrompt>;
  observe(snapshot: ManagedQueueSnapshot): void;
}
function stablePrompt(
  identity: ManagedNativeGatewayIdentity,
  nativeId: string,
): string {
  const bytes = createHash("sha256")
    .update(
      JSON.stringify([
        identity.serverId,
        identity.ownerId,
        identity.chatId,
        identity.threadId,
        nativeId,
      ]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Native queue triggers must be permanently denied BEFORE constructing this importer. */
export class ManagedNativeQueueCutover {
  private pending: Promise<void> | null = null;
  private dirty = false;
  constructor(private readonly options: ManagedNativeQueueCutoverOptions) {}

  synchronize(): Promise<void> {
    this.dirty = true;
    if (this.pending) return this.pending;
    const run = this.drain();
    this.pending = run;
    void run
      .finally(() => {
        if (this.pending === run) this.pending = null;
      })
      .catch(() => {});
    return run;
  }

  private async drain(): Promise<void> {
    const signal = this.options.signal();
    const assertCurrent = () => {
      signal.throwIfAborted();
      this.options.assertCurrent();
    };
    const context = (promptId: string) => ({
      chatId: this.options.identity.chatId,
      operationId: `queue-import:${promptId}`,
      direction: "request" as const,
    });
    const complete = async (snapshot: ManagedQueueImportResult) => {
      this.options.observe(snapshot);
      for (const record of snapshot.imports) {
        if (record.status !== "pending" && record.status !== "uncertain")
          continue;
        assertCurrent();
        const source = sourceSchema.parse(
          await openNativeCommandContent({
            service: this.options.encryption,
            context: context(record.promptId),
            envelope: record.protectedSource,
          }),
        );
        if (source.id !== record.nativeItemId)
          throw new Error(
            "The native queue import source belongs to another item.",
          );
        const receipt = await this.options.runtime.deleteManagedNativeQueue(
          {
            threadId: this.options.identity.threadId,
            runnerGeneration: this.options.runnerGeneration(),
            operationId: record.nativeDeleteOperationId,
            queuedSubmissionId: source.id,
            expectedInput: source.input,
            expectedClientUserMessageId: source.clientUserMessageId,
          },
          this.options.identity.runtimeGeneration,
        );
        assertCurrent();
        const acknowledged = await this.options.client.acknowledgeImport(
          {
            session: this.options.session(),
            runnerGeneration: this.options.runnerGeneration(),
            importId: record.importId,
            sourceDigest: record.sourceDigest,
            receipt,
          },
          signal,
        );
        this.options.observe(acknowledged);
      }
    };
    while (this.dirty) {
      this.dirty = false;
      assertCurrent();
      // Recover the delete-committed/ACK-lost window even when native storage is empty.
      await complete(
        await this.options.client.import(
          {
            session: this.options.session(),
            runnerGeneration: this.options.runnerGeneration(),
            items: [],
          },
          signal,
        ),
      );
      const sources = await this.options.runtime.readManagedNativeQueue(
        this.options.identity.threadId,
        this.options.identity.runtimeGeneration,
      );
      for (const raw of sources) {
        assertCurrent();
        const source = sourceSchema.parse(raw);
        const promptId = stablePrompt(this.options.identity, source.id);
        const protectedSource = await protectNativeCommandContent({
          service: this.options.encryption,
          context: context(promptId),
          content: source,
        });
        const prepared = await this.options.preparePrompt({
          id: promptId,
          request: {
            method: "thread/queue/add",
            params: {
              threadId: this.options.identity.threadId,
              input: source.input,
              clientUserMessageId: source.clientUserMessageId,
              managed: {
                operationId: `queue-import:${promptId}`,
                action: "literal",
              },
            },
            identity: this.options.identity,
            connectionId: this.options.session().connectionId!,
            signal,
            assertCurrent,
          },
        });
        assertCurrent();
        await complete(
          await this.options.client.import(
            {
              session: this.options.session(),
              runnerGeneration: this.options.runnerGeneration(),
              items: [
                {
                  nativeItemId: source.id,
                  sourceDigest: protectedSource.digest,
                  protectedSource: protectedSource.envelope,
                  ...prepared,
                },
              ],
            },
            signal,
          ),
        );
      }
    }
  }
}
