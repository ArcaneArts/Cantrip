import path from "node:path";
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
    this.sources = new ManagedNativeHistorySources({
      ...common,
      directory: sourceDirectory,
      snapshotDelayMs: options.snapshotDelayMs,
      onPersisted: (journal, scope) => this.projection.wake(journal, scope),
      onError: (error, context) => options.onError?.(error, context),
    } satisfies SourceOptions);
  }

  bind(input: Parameters<ManagedNativeHistorySources["bind"]>[0]) {
    return this.sources.bind(input);
  }

  async flush(): Promise<void> {
    await this.sources.flush();
    await this.projection.flush();
  }

  /** Abort delivery and detach observation immediately, then await work that
   * still touches encrypted storage. Pending memory remains explicitly unsaved. */
  stop(): Promise<ReturnType<ManagedNativeHistorySources["stop"]>> {
    if (!this.stopping) {
      this.stopping = Promise.all([
        this.sources.stopAndWait(),
        this.projection.stop(),
      ]).then(([pending]) => pending);
    }
    return this.stopping;
  }
}
