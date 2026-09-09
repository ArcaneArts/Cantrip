import path from "node:path";
import { NativeHistoryDescendants } from "./native-history-descendants.js";
import type { AttachmentStore } from "./attachment-store.js";
import type { NativeHistoryClient } from "./native-history-client.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";
import { ManagedNativeHistorySources } from "./managed-native-history-sources.js";
import { ManagedNativeHistoryProjection } from "./managed-native-history-projection.js";
import { createNativeHistoryProjectorAdapters } from "./native-history-projector-adapters.js";

type SourceOptions = ConstructorParameters<
  typeof ManagedNativeHistorySources
>[0];
type ProjectionOptions = ConstructorParameters<
  typeof ManagedNativeHistoryProjection
>[0];
type Diagnostic = {
  phase: string;
  chatId?: string;
  threadId?: string;
  bindingId?: string;
  generation?: string;
  journalKey?: string | null;
};
interface Options {
  directory: string;
  workerId: string;
  service: WorkerEncryptionService;
  client: NativeHistoryClient;
  attachments: AttachmentStore;
  onError?(error: unknown, context: Diagnostic): void;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  snapshotDelayMs?: number;
}

/** The worker's shared history lifetime, independent of presentation or turns.
 * Native input never awaits projection. Saved source wakes delivery, and existing
 * journals recover at startup without another native turn or UI connection. */
export class ManagedNativeHistory {
  private readonly roots = new Map<
    string,
    Parameters<ManagedNativeHistorySources["bind"]>[0]
  >();
  private readonly descendants: NativeHistoryDescendants;
  private readonly sources: ManagedNativeHistorySources;
  private readonly projection: ManagedNativeHistoryProjection;
  private stopping?: Promise<ReturnType<ManagedNativeHistorySources["stop"]>>;

  constructor(options: Options) {
    const sourceDirectory = path.join(
      options.directory,
      "native-history-sources",
    );
    const canonicalDirectory = path.join(
      options.directory,
      "native-history-canonical",
    );
    const common = {
      workerId: options.workerId,
      service: options.service,
      client: options.client,
      retryDelayMs: options.retryDelayMs,
      maxRetryDelayMs: options.maxRetryDelayMs,
    };
    const projector: ProjectionOptions["projector"] = async (
      binding,
      signal,
      source,
    ) =>
      createNativeHistoryProjectorAdapters({
        directory: path.join(canonicalDirectory, "materialized"),
        binding,
        source,
        signal,
        service: options.service,
        attachments: options.attachments,
      });
    this.projection = new ManagedNativeHistoryProjection({
      ...common,
      directory: canonicalDirectory,
      sourceDirectory,
      projector,
      onError: (error, scope) =>
        options.onError?.(error, { ...scope, phase: "project" }),
      onRecoveryError: (error, journalKey) =>
        options.onError?.(error, { phase: "recover", journalKey }),
    });
    this.descendants = new NativeHistoryDescendants({
      client: options.client,
      bind: (input) => this.bind(input),
      retryDelayMs: options.retryDelayMs,
      onError: (error, scope) =>
        options.onError?.(error, { ...scope, phase: "discover-children" }),
    });
    this.sources = new ManagedNativeHistorySources({
      ...common,
      directory: sourceDirectory,
      snapshotDelayMs: options.snapshotDelayMs,
      onPersisted: (journal, scope, runtime) => {
        this.projection.wake(journal, scope);
        this.descendants.wake(journal, scope, runtime);
      },
      onError: (error, context) => options.onError?.(error, context),
    } satisfies SourceOptions);
  }

  bind(input: Parameters<ManagedNativeHistorySources["bind"]>[0]) {
    const capture = this.sources.bind(input);
    this.roots.set(JSON.stringify([input.chatId, input.threadId]), input);
    return capture;
  }

  outputScope(chatId: string, rootThreadId: string, threadId: string) {
    const root = this.roots.get(JSON.stringify([chatId, rootThreadId]));
    if (!root)
      throw new Error("Child native output has no managed history root.");
    return this.descendants.resolve(root, threadId);
  }

  async flush(): Promise<void> {
    let revision: number;
    do {
      revision = this.descendants.revision;
      await this.sources.flush();
      await this.descendants.flush();
    } while (revision !== this.descendants.revision);
    await this.projection.flush();
  }

  /** Abort delivery and detach observation immediately, then await work that
   * still touches encrypted storage. Pending memory remains explicitly unsaved. */
  stop(): Promise<ReturnType<ManagedNativeHistorySources["stop"]>> {
    if (!this.stopping) {
      this.stopping = Promise.all([
        this.sources.stopAndWait(),
        this.projection.stop(),
        this.descendants.stop(),
      ]).then(([pending]) => pending);
    }
    return this.stopping;
  }
}
