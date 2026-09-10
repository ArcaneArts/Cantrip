import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  nativeRuntimeHandoffStateSchema,
  type NativeRuntimeHandoffState,
} from "@cantrip/protocol";
import {
  ensureHistoryDirectory,
  writeImmutableHistoryFile,
  serializeHistoryOperation,
} from "../native-history-outbox-files.js";

const id = z.string().min(1).max(255);
const scopeSchema = z
  .object({ serverId: id, ownerId: id, workerId: id })
  .strict();
const providerSchema = z
  .object({ id, kind: id, accountId: id.nullable() })
  .strict();
const recordSchema = z
  .object({
    version: z.literal(1),
    scope: scopeSchema,
    chatId: id,
    threadId: id,
    operationId: z.string().uuid(),
    previousOperationId: z.string().uuid().nullable(),
    provider: providerSchema,
  })
  .strict();
export type ManagedRuntimeNamespaceScope = z.infer<typeof scopeSchema>;
export type ManagedRuntimeNamespaceProvider = z.infer<typeof providerSchema>;
type Record = z.infer<typeof recordSchema>;
export type ManagedRuntimeNamespace = Record & { home: string };
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Keep conversation identity when routing commands whose other fields differ. */
export function managedRuntimeTarget(value: unknown): {
  threadId?: string;
  chatId?: string;
} {
  if (!value || typeof value !== "object") return {};
  const command = value as {
    threadId?: unknown;
    chatId?: unknown;
    session?: { chatId?: unknown };
  };
  const chatId = command.chatId ?? command.session?.chatId;
  return {
    ...(typeof command.threadId === "string"
      ? { threadId: command.threadId }
      : {}),
    ...(typeof chatId === "string" ? { chatId } : {}),
  };
}

/** Immutable handoff chain: an old retry can never overwrite a newer selection.
 * The server remains the owner of route/phase; these worker-local records select
 * storage only after its canonical commit. No credentials/configuration are copied. */
export class ManagedRuntimeNamespaces {
  constructor(private readonly directory: string) {}

  private root(scope: ManagedRuntimeNamespaceScope, threadId: string) {
    scopeSchema.parse(scope);
    id.parse(threadId);
    return path.join(
      this.directory,
      "managed-native-namespaces",
      digest([scope.serverId, scope.ownerId, scope.workerId]),
      digest(threadId),
    );
  }

  destination(
    scope: ManagedRuntimeNamespaceScope,
    threadId: string,
    operationId: string,
  ) {
    z.string().uuid().parse(operationId);
    return path.join(this.root(scope, threadId), "homes", operationId);
  }

  /** Target-local reads avoid making another conversation's damaged journal a
   * worker-wide startup failure. No cached selection survives a committed switch. */
  private records(
    scope: ManagedRuntimeNamespaceScope,
    threadId: string,
  ): Record[] {
    const directory = path.join(this.root(scope, threadId), "selections");
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return names
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const record = recordSchema.parse(
          JSON.parse(readFileSync(path.join(directory, name), "utf8")),
        );
        if (
          name !== `${record.operationId}.json` ||
          record.threadId !== threadId ||
          record.scope.serverId !== scope.serverId ||
          record.scope.ownerId !== scope.ownerId ||
          record.scope.workerId !== scope.workerId
        )
          throw new Error(
            "Managed runtime namespace journal identity mismatch.",
          );
        return record;
      });
  }

  current(
    scope: ManagedRuntimeNamespaceScope,
    threadId: string,
  ): ManagedRuntimeNamespace | null {
    const records = this.records(scope, threadId);
    if (!records.length) return null;
    const byId = new Map(records.map((record) => [record.operationId, record]));
    const parents = new Set(
      records.flatMap((record) =>
        record.previousOperationId ? [record.previousOperationId] : [],
      ),
    );
    const heads = records.filter((record) => !parents.has(record.operationId));
    if (heads.length !== 1)
      throw new Error(
        "Managed runtime namespace history has conflicting selections.",
      );
    const head = heads[0]!;
    const visited = new Set<string>();
    let cursor: Record | undefined = head;
    while (cursor) {
      if (visited.has(cursor.operationId) || cursor.chatId !== head.chatId)
        throw new Error("Managed runtime namespace history is inconsistent.");
      visited.add(cursor.operationId);
      if (cursor.previousOperationId === null) break;
      cursor = byId.get(cursor.previousOperationId);
      if (!cursor)
        throw new Error("Managed runtime namespace history is incomplete.");
    }
    if (visited.size !== records.length)
      throw new Error(
        "Managed runtime namespace history has disconnected selections.",
      );
    return {
      ...head,
      home: this.destination(scope, threadId, head.operationId),
    };
  }

  resolve(
    scope: ManagedRuntimeNamespaceScope,
    input: {
      threadId?: string | null;
      chatId?: string | null;
      provider: { id: string; kind: string; accountId?: string | null };
    },
  ): ManagedRuntimeNamespace | null {
    if (!input.threadId) return null;
    const current = this.current(scope, input.threadId);
    if (!current) return null;
    if (
      (input.chatId && current.chatId !== input.chatId) ||
      current.provider.id !== input.provider.id ||
      current.provider.kind !== input.provider.kind ||
      current.provider.accountId !== (input.provider.accountId ?? null)
    )
      throw new Error(
        "The managed runtime route changed. Reload the canonical conversation binding.",
      );
    return current;
  }

  async select(input: {
    scope: ManagedRuntimeNamespaceScope;
    handoff: NativeRuntimeHandoffState;
    provider: ManagedRuntimeNamespaceProvider;
    previousOperationId: string | null;
  }): Promise<ManagedRuntimeNamespace> {
    const state = nativeRuntimeHandoffStateSchema.parse(input.handoff);
    const provider = providerSchema.parse(input.provider);
    const selection = state.prepared?.snapshot.modelAttribution?.selection;
    if (
      !["committed", "completed"].includes(state.phase) ||
      state.workerId !== input.scope.workerId ||
      state.source.workerId !== input.scope.workerId ||
      state.source.chatId !== state.chatId ||
      selection?.status !== "resolved" ||
      selection.workerId !== input.scope.workerId ||
      selection.providerId !== provider.id ||
      selection.providerAccountId !== provider.accountId ||
      selection.routeId !== state.targetModelRouteId ||
      provider.accountId !== state.targetProviderAccountId ||
      state.prepared?.threadId !== state.source.threadId
    )
      throw new Error(
        "A namespace selection requires the committed destination binding.",
      );
    const directory = path.join(
      this.root(input.scope, state.source.threadId),
      "selections",
    );
    const record = recordSchema.parse({
      version: 1,
      scope: input.scope,
      chatId: state.chatId,
      threadId: state.source.threadId,
      operationId: state.operationId,
      previousOperationId: input.previousOperationId,
      provider,
    });
    return serializeHistoryOperation(directory, async () => {
      const current = this.current(input.scope, record.threadId);
      if (current?.operationId === record.operationId) {
        if (
          current.previousOperationId !== record.previousOperationId ||
          current.chatId !== record.chatId ||
          digest(current.provider) !== digest(record.provider)
        )
          throw new Error("Conflicting managed namespace retry.");
        return current;
      }
      if ((current?.operationId ?? null) !== record.previousOperationId)
        throw new Error("Managed runtime namespace source was replaced.");
      if (current && current.chatId !== record.chatId)
        throw new Error("Managed runtime namespace belongs to another chat.");
      await ensureHistoryDirectory(directory);
      const filename = path.join(directory, `${record.operationId}.json`);
      if (
        !(await writeImmutableHistoryFile(filename, JSON.stringify(record)))
      ) {
        const stored = recordSchema.parse(
          JSON.parse(readFileSync(filename, "utf8")),
        );
        if (digest(stored) !== digest(record))
          throw new Error("Conflicting managed namespace publication.");
      }
      const selected = this.current(input.scope, record.threadId);
      if (selected?.operationId !== record.operationId)
        throw new Error(
          "Managed runtime namespace was superseded during publication.",
        );
      return selected;
    });
  }
}
