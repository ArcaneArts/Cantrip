import { type NativeTurnSettingsEvidence } from "./native-turn-settings-evidence";
export {
  nativeCorrelatedTurnIdentities,
  nativeTurnSettingsForMessages,
  mergeNativeTurnSettingsEvidence,
  type NativeTurnSettingsEvidence,
} from "./native-turn-settings-evidence";
import { clearSensitiveBytes, decryptNativeHistoryTurn } from "@cantrip/crypto";
import {
  nativeHistoryTurnReadResponseSchema,
  nativeInitialTurnSettingsSchema,
  type ChatMessage,
  type NativeHistoryTurnReadResponse,
  type NativeInitialTurnSettings,
} from "@cantrip/protocol";
import {
  clientEncryption,
  ClientEncryptionError,
  type ClientEncryptionService,
} from "./client-encryption";
import {
  clientSessionIdentityMatches,
  type ClientSessionIdentitySnapshot,
} from "./client-session";
import { request } from "./api-client";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const key = (value: { threadId: string; turnId: string }) =>
  JSON.stringify([value.threadId, value.turnId]);

function initialEvidence(
  source: unknown,
  turnId: string,
): { conflict: boolean; value?: NativeInitialTurnSettings } {
  if (!object(source))
    throw new Error("Unsupported native turn archive format.");
  let metadata: unknown;
  let conflict = false;
  if (source.version === 2 && object(source.reducedTurn)) {
    const turn = source.reducedTurn;
    if (turn.id !== turnId)
      throw new Error("Archived metadata belongs to another native turn.");
    metadata = turn.metadata;
    conflict =
      Array.isArray(turn.conflicts) &&
      turn.conflicts.some(
        (entry) =>
          object(entry) &&
          (entry.initialSettingsConflict === true ||
            Object.hasOwn(entry, "initialSettings")),
      );
  } else if (source.version === 1 && object(source.nativeTurn)) {
    if (
      source.nativeTurn.id !== turnId ||
      (object(source.history) && source.history.turnId !== turnId)
    )
      throw new Error("Archived metadata belongs to another native turn.");
    metadata = source.history;
  } else throw new Error("Unsupported native turn archive format.");
  if (object(metadata)) {
    conflict ||= metadata.initialSettingsConflict === true;
    if (Object.hasOwn(metadata, "initialSettings"))
      return {
        conflict,
        value: nativeInitialTurnSettingsSchema.parse(metadata.initialSettings),
      };
  }
  return { conflict };
}

/** Decrypted archive bodies and component key copies never enter query caches.
 * Only immutable initial-selection evidence escapes for existing turn grouping. */
export async function openNativeTurnSettings(input: {
  chatId: string;
  response: NativeHistoryTurnReadResponse;
  identity: ClientSessionIdentitySnapshot;
  options?: {
    service?: ClientEncryptionService;
    identityMatches?: (identity: ClientSessionIdentitySnapshot) => boolean;
  };
}): Promise<NativeTurnSettingsEvidence[]> {
  const response = nativeHistoryTurnReadResponseSchema.parse(input.response);
  if (response.chatId !== input.chatId)
    throw new Error("Turn archive belongs to another chat.");
  const service = input.options?.service ?? clientEncryption;
  const matches =
    input.options?.identityMatches ?? clientSessionIdentityMatches;
  const unlocked = service.getSnapshot();
  const identity = input.identity;
  const assertLifetime = () => {
    if (
      !matches(identity) ||
      service.getSnapshot() !== unlocked ||
      unlocked.status !== "ready" ||
      unlocked.identity?.ownerId !== identity.userId ||
      unlocked.identity.serverId !== identity.serverId
    )
      throw new ClientEncryptionError(
        "locked",
        "The encryption session changed while reading native history.",
      );
  };
  assertLifetime();
  const groups = new Map<
    string,
    {
      threadId: string;
      turnId: string;
      conflict: boolean;
      values: NativeInitialTurnSettings[];
    }
  >();
  for (const entry of response.turns) {
    assertLifetime();
    const componentKey = service.componentKey({
      component: "chat-content",
      identity: unlocked.identity!,
      keyRevision: entry.turn.metadata.keyRevision,
    });
    let observed: ReturnType<typeof initialEvidence>;
    try {
      observed = initialEvidence(
        await decryptNativeHistoryTurn({
          ownerId: identity.userId,
          serverId: identity.serverId,
          componentKey,
          chatId: input.chatId,
          bindingId: entry.bindingId,
          workerId: entry.workerId,
          turn: entry.turn,
        }),
        entry.turn.turnId,
      );
    } finally {
      clearSensitiveBytes(componentKey);
    }
    assertLifetime();
    const id = key(entry.turn);
    const group = groups.get(id) ?? {
      threadId: entry.turn.threadId,
      turnId: entry.turn.turnId,
      conflict: false,
      values: [],
    };
    group.conflict ||= observed.conflict;
    if (observed.value) group.values.push(observed.value);
    groups.set(id, group);
  }
  return [...groups.values()].map(({ threadId, turnId, conflict, values }) => {
    if (
      conflict ||
      values.some(
        (value) => JSON.stringify(value) !== JSON.stringify(values[0]),
      )
    )
      return { threadId, turnId, status: "conflict" };
    return values[0]
      ? { threadId, turnId, status: "available", initialSettings: values[0] }
      : { threadId, turnId, status: "unavailable" };
  });
}

// Existing archives include whole reduced turns. Bound response/decryption
// working sets without limiting how much history the caller can recover.
// A dedicated encrypted initial-settings projection can remove this overhead.
const TURN_ARCHIVE_READ_BATCH_SIZE = 32;
export async function readNativeTurnSettings(input: {
  chatId: string;
  turns: { threadId: string; turnId: string }[];
  identity: ClientSessionIdentitySnapshot;
  signal?: AbortSignal;
}) {
  const results: NativeTurnSettingsEvidence[] = [];
  for (
    let offset = 0;
    offset < input.turns.length;
    offset += TURN_ARCHIVE_READ_BATCH_SIZE
  ) {
    input.signal?.throwIfAborted();
    const turns = input.turns.slice(
      offset,
      offset + TURN_ARCHIVE_READ_BATCH_SIZE,
    );
    const expected = new Set(turns.map(key));
    const response = nativeHistoryTurnReadResponseSchema.parse(
      await request(
        `/api/chats/${encodeURIComponent(input.chatId)}/native-history/turns/read`,
        {
          method: "POST",
          body: JSON.stringify({ turns }),
          signal: input.signal,
        },
        { expectedIdentity: input.identity },
      ),
    );
    if (response.turns.some((entry) => !expected.has(key(entry.turn))))
      throw new Error("Turn archive contains an unrequested native turn.");
    results.push(...(await openNativeTurnSettings({ ...input, response })));
  }
  input.signal?.throwIfAborted();
  return results;
}

/** Enrich only an existing native summary, leaving all IDs, order, lifecycle and
 * user/assistant messages intact. Conflicts cannot be revived by older evidence. */
export function enrichNativeTurnSummaries(
  messages: ChatMessage[],
  evidence: NativeTurnSettingsEvidence[],
): ChatMessage[] {
  const byTurn = new Map(evidence.map((entry) => [key(entry), entry]));
  return messages.map((message) => {
    let changed = false;
    const content = message.content.map((item) => {
      if (item.type !== "activity" || item.activity.type !== "turnSummary")
        return item;
      const activity = item.activity;
      const correlation = activity.correlation;
      if (
        !correlation?.threadId ||
        !correlation.turnId ||
        (activity.agentScope &&
          activity.agentScope.agentThreadId !== correlation.threadId)
      )
        return item;
      const observed = byTurn.get(
        key({ threadId: correlation.threadId, turnId: correlation.turnId }),
      );
      if (!observed || observed.status === "unavailable") return item;
      const conflict =
        activity.initialSettingsConflict === true ||
        observed.status === "conflict" ||
        (observed.status === "available" &&
          activity.initialSettings &&
          JSON.stringify(activity.initialSettings) !==
            JSON.stringify(observed.initialSettings));
      if (conflict) {
        changed = true;
        const { initialSettings: _initial, ...rest } = activity;
        return {
          ...item,
          activity: { ...rest, initialSettingsConflict: true },
        };
      }
      if (observed.status === "available" && !activity.initialSettings) {
        changed = true;
        return {
          ...item,
          activity: { ...activity, initialSettings: observed.initialSettings },
        };
      }
      return item;
    });
    return changed ? { ...message, content } : message;
  });
}
