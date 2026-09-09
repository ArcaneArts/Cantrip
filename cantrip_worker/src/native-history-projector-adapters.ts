import {
  agentScopeSchema,
  type AgentScope,
  type ChatAttachmentOpaqueSummary,
  type NativeHistoryBinding,
  type NativeHistoryItemIdentity,
} from "@cantrip/protocol";
import path from "node:path";
import type { WorkerEncryptionService } from "./worker-encryption.js";
import type { AttachmentStore } from "./attachment-store.js";
import type { NativeHistorySourceJournal } from "./native-history-source-journal.js";
import type { createNativeHistoryProjector } from "./native-history-projector.js";
import { NativeHistoryAttachmentStore } from "./native-history-attachment-store.js";
import { createNativeHistoryInputMaterializer } from "./native-history-input-materializer.js";
import {
  NativeHistoryTurnContextIndex,
  resolveNativeHistoryTurnContext,
} from "./native-history-turn-context.js";

type Adapters = Pick<
  Parameters<typeof createNativeHistoryProjector>[0],
  "prepare" | "context" | "materialize" | "associate"
>;

/** Adapters for an already authorized binding. No current chat cwd, model or mode
 * is accepted. Native input remains independent of historical presentation. */
export function createNativeHistoryProjectorAdapters(options: {
  directory: string;
  binding: NativeHistoryBinding;
  source: NativeHistorySourceJournal;
  service: WorkerEncryptionService;
  attachments: AttachmentStore;
  signal?: AbortSignal;
  /** Child scope must come from verified lineage, never just a native item name. */
  childScope?(turnId: string, rootTurnId: string): Promise<AgentScope>;
  childAssociation?: Adapters["associate"];
  publishedAttachments?(
    identity: NativeHistoryItemIdentity,
  ): Promise<ChatAttachmentOpaqueSummary[]>;
}): Adapters {
  const { binding, service, source } = options;
  if (
    source.scope.bindingId !== binding.id ||
    source.scope.threadId !== binding.threadId ||
    source.scope.chatId !== binding.chatId ||
    source.scope.workerId !== binding.workerId ||
    source.scope.ownerId !== service.ownerId() ||
    source.scope.serverId !== service.serverIdentity()
  )
    throw new Error(
      "Native history adapters require the exact authorized source binding.",
    );
  const contexts = new NativeHistoryTurnContextIndex(source, options.signal);
  const store = new NativeHistoryAttachmentStore({
    directory: path.join(options.directory, "attachments"),
    binding,
    service,
    attachments: options.attachments,
  });
  return {
    prepare: () => contexts.refresh(),
    async context(_item, turn) {
      const { rootTurnId, ...presentation } = resolveNativeHistoryTurnContext(
        contexts.read(turn),
      );
      if (!rootTurnId || rootTurnId === turn.id) return presentation;
      if (!options.childScope)
        throw new Error("Native child history requires verified parent scope.");
      const agentScope = agentScopeSchema.parse(
        await options.childScope(turn.id, rootTurnId),
      );
      if (
        agentScope.agentThreadId !== binding.threadId ||
        agentScope.rootTurnId !== rootTurnId ||
        agentScope.isRoot
      )
        throw new Error(
          "Native history child scope belongs to another thread.",
        );
      return { ...presentation, agentScope };
    },
    materialize: createNativeHistoryInputMaterializer({
      directory: path.join(options.directory, "input-parts"),
      binding,
      service,
      files: options.attachments,
      store,
      publishedAttachments: options.publishedAttachments,
    }),
    async associate(item, turn) {
      const { rootTurnId } = resolveNativeHistoryTurnContext(
        contexts.read(turn),
      );
      if (rootTurnId && rootTurnId !== turn.id) {
        if (!options.childAssociation)
          throw new Error(
            "Native child history requires verified output identity.",
          );
        return options.childAssociation(item, turn);
      }
      // Existing canonical root output is adopted only through server-owned
      // command provenance. Other components keep their native identity.
      return item.identity.identityKind === "canonical" &&
        (item.identity.component === "assistant" ||
          item.identity.component === "activity")
        ? { kind: "output" }
        : { kind: "native" };
    },
  };
}
