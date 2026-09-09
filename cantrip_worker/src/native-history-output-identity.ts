import {
  nativeHistoryItemIdentitySchema,
  nativeHistoryItemMappingSchema,
  type AgentScope,
  type NativeHistoryBinding,
  type NativeHistoryItemIdentity,
  type NativeHistoryBindingOpen,
} from "@cantrip/protocol";
import type { NativeHistoryClient } from "./native-history-client.js";
import type {
  EncryptedChatOutput,
  EncryptedChatOutputIdentityResolver,
} from "./chat-message-encryption.js";

/** One resolver per bound sealer lifetime. The native adapter supplies actual
 * canonical identity, or null for non-native auxiliary output. Failed lookups
 * are retryable; successful concurrent lookups share one immutable mapping. */
export function createNativeHistoryOutputIdentityResolver(options: {
  binding: NativeHistoryBinding;
  client: Pick<NativeHistoryClient, "resolve">;
  identity(output: EncryptedChatOutput): NativeHistoryItemIdentity | null;
}): EncryptedChatOutputIdentityResolver {
  const pending = new Map<
    string,
    Promise<{ id: string; idempotencyKey: string }>
  >();
  return async (output) => {
    const selected = options.identity(output);
    if (!selected) return null;
    const identity = nativeHistoryItemIdentitySchema.parse(selected);
    if (identity.threadId !== options.binding.threadId)
      throw new Error(
        "Native output identity belongs to a different history binding.",
      );
    const key = JSON.stringify(identity);
    let resolved = pending.get(key);
    if (!resolved) {
      resolved = (async () => {
        const mappings = await options.client.resolve({
          chatId: options.binding.chatId,
          bindingId: options.binding.id,
          items: [
            {
              identity,
              association: {
                kind: "output",
                ...((output.kind === "message"
                  ? output.message
                  : output.activity
                ).agentScope?.isRoot === false
                  ? {
                      rootTurnId: (output.kind === "message"
                        ? output.message
                        : output.activity
                      ).agentScope!.rootTurnId,
                    }
                  : {}),
              },
            },
          ],
        });
        if (mappings.length !== 1)
          throw new Error(
            "Native output resolution omitted its unique mapping.",
          );
        const mapping = nativeHistoryItemMappingSchema.parse(mappings[0]);
        if (JSON.stringify(mapping.identity) !== key || mapping.preservedInput)
          throw new Error(
            "Native output resolution returned an unrelated mapping.",
          );
        return {
          id: mapping.messageId,
          idempotencyKey: mapping.idempotencyKey,
        };
      })();
      pending.set(key, resolved);
      const attempt = resolved;
      void attempt.catch(() => {
        if (pending.get(key) === attempt) pending.delete(key);
      });
    }
    return resolved;
  };
}

/** Adapter for actual live native item notifications. Snapshot/legacy items and
 * synthetic summaries need their own identity provenance and are not relabeled
 * canonical here. This resolver owns no input or active-turn authority. */
export function createManagedNativeOutputIdentityResolver(options: {
  client: Pick<NativeHistoryClient, "open" | "resolve">;
  scope(
    threadId: string,
    agentScope?: AgentScope,
  ):
    | Omit<NativeHistoryBindingOpen, "workerId">
    | null
    | Promise<Omit<NativeHistoryBindingOpen, "workerId"> | null>;
  signal?: AbortSignal;
}): EncryptedChatOutputIdentityResolver {
  const bindings = new Map<
    string,
    Promise<EncryptedChatOutputIdentityResolver>
  >();
  const requestSignal = () =>
    options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
  const identity = (
    output: EncryptedChatOutput,
  ): NativeHistoryItemIdentity | null => {
    const item = output.kind === "message" ? output.message : output.activity;
    const correlation = item.correlation;
    if (
      !correlation?.sourceMethod.startsWith("item/") ||
      !correlation.threadId ||
      !correlation.turnId ||
      !correlation.itemId ||
      item.id !== correlation.itemId
    )
      return null;
    return {
      threadId: correlation.threadId,
      turnId: correlation.turnId,
      itemId: correlation.itemId,
      component: output.kind === "message" ? "assistant" : "activity",
      identityKind: "canonical",
    };
  };
  return async (output) => {
    const selected = identity(output);
    if (!selected) return null;
    const scope = await options.scope(
      selected.threadId,
      (output.kind === "message" ? output.message : output.activity).agentScope,
    );
    if (!scope)
      throw new Error(
        "Live native output is missing its dispatched history scope.",
      );
    if (selected.threadId !== scope.threadId) return null;
    const key = JSON.stringify([scope.chatId, scope.threadId]);
    let ready = bindings.get(key);
    if (!ready) {
      ready = (async () => {
        const binding = await options.client.open(scope, requestSignal());
        if (
          binding.chatId !== scope.chatId ||
          binding.threadId !== scope.threadId
        )
          throw new Error(
            "Live native output received an unrelated history binding.",
          );
        return createNativeHistoryOutputIdentityResolver({
          binding,
          identity,
          client: {
            resolve: (input) => options.client.resolve(input, requestSignal()),
          },
        });
      })();
      bindings.set(key, ready);
      const attempt = ready;
      void attempt.catch(() => {
        if (bindings.get(key) === attempt) bindings.delete(key);
      });
    }
    return (await ready)(output);
  };
}
