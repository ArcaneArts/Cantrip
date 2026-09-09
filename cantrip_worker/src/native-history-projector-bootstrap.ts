import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { NativeHistoryRecoverySnapshot } from "./native-history-recovery.js";
import {
  nativeHistoryProjectorStateSchema,
  nativeHistorySourceFingerprint,
} from "./native-history-projector.js";
import {
  nativeHistoryStateSchema,
  nativeHistoryStateTurnSchema,
  nativeHistoryStateItemSchema,
  type NativeHistoryStateTurn,
  type NativeHistoryObject,
} from "./native-history-state.js";

const object = z.record(z.string(), z.json());
const turnContent = z
  .object({
    version: z.literal(2),
    reducedTurn: nativeHistoryStateTurnSchema.omit({ items: true }),
    evidence: nativeHistoryStateSchema.shape.evidence,
  })
  .strict();
const identityKey = (identity: {
  threadId: string;
  turnId: string;
  itemId: string;
  component: string;
  identityKind: string;
}) =>
  JSON.stringify([
    identity.threadId,
    identity.turnId,
    identity.itemId,
    identity.component,
    identity.identityKind,
  ]);
const terminal = (value: unknown) =>
  ["completed", "failed", "interrupted"].includes(String(value));
function recordId(value: string) {
  const h = createHash("sha256").update(value).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Combine observations without treating another binding's revision as newer.
 * Disagreeing fields remain in the original candidates; an ambiguous field is
 * absent from the aggregate until a fresh native observation resolves it. */
function consensus(
  values: NativeHistoryObject[],
  contexts = false,
): NativeHistoryObject {
  const result: NativeHistoryObject = {};
  const put = (key: string, value: NativeHistoryObject[string]) =>
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  for (const key of new Set(values.flatMap((value) => Object.keys(value)))) {
    const candidates = values
      .filter((value) => Object.hasOwn(value, key))
      .map((value) => value[key]!);
    const present = candidates.filter((value) => value !== null);
    if (!present.length) {
      put(key, null);
      continue;
    }
    if (contexts && key === "contexts") {
      const all = present.flatMap((value) =>
        Array.isArray(value) ? value : [],
      );
      put(
        key,
        all.filter(
          (value, index) =>
            !all
              .slice(0, index)
              .some((prior) => isDeepStrictEqual(prior, value)),
        ),
      );
    } else {
      const selected =
        key === "status" && present.some(terminal)
          ? present.filter(terminal)
          : present;
      if (selected.every((value) => isDeepStrictEqual(value, selected[0])))
        put(key, selected[0]!);
    }
  }
  return result;
}

/** Reconstruct the selected canonical transcript and revision floors from an
 * authenticated/decrypted recovery read. Accepted nonselected candidates stay in
 * the server archive; their counters never select a body. This does not restore
 * lost outbox identities or resolve a later concurrent canonical write. */
export function restoreNativeHistoryProjectorState(
  recovery: NativeHistoryRecoverySnapshot,
) {
  const source = nativeHistoryStateSchema.parse({
    version: 1,
    threadId: recovery.binding.threadId,
    turns: [],
    evidence: [],
    notifications: [],
  });
  const turns = new Map<string, NativeHistoryStateTurn>();
  const candidates = new Map<
    string,
    Array<{
      body: NativeHistoryObject;
      metadata: NativeHistoryObject | null;
      conflicts: NativeHistoryObject[];
    }>
  >();
  const origin = {
    kind: "snapshot" as const,
    generation: `archive:${recovery.snapshotId}`,
    sequence: 0,
  };
  const ensureTurn = (id: string, ordinal: number) => {
    let turn = turns.get(id);
    if (!turn) {
      turn = {
        id,
        ordinal,
        revision: 1,
        body: { id },
        metadata: null,
        origin,
        items: [],
        conflicts: [],
      };
      turns.set(id, turn);
    }
    return turn;
  };
  const evidenceById = new Map<string, (typeof source.evidence)[number]>();
  const evidence = (record: (typeof source.evidence)[number]) => {
    const existing = evidenceById.get(record.recordId);
    if (existing && !isDeepStrictEqual(existing, record))
      throw new Error(
        "Recovered native evidence has conflicting record identities.",
      );
    if (!existing) {
      const retained = structuredClone(record);
      evidenceById.set(record.recordId, retained);
      source.evidence.push(retained);
    }
  };
  const itemFloors = new Map<string, number>();
  const turnFloors = new Map<string, number>();
  for (const entry of recovery.batches) {
    for (const item of entry.batch?.items ?? []) {
      const key = identityKey(item.identity);
      itemFloors.set(key, Math.max(itemFloors.get(key) ?? 0, item.revision));
    }
    if (entry.bindingId === recovery.binding.id)
      for (const turn of entry.batch?.turns ?? [])
        turnFloors.set(
          turn.turnId,
          Math.max(turnFloors.get(turn.turnId) ?? 0, turn.revision),
        );
  }
  for (const entry of recovery.turns) {
    if (entry.turn.threadId !== source.threadId)
      throw new Error("Recovered native turn belongs to another thread.");
    ensureTurn(entry.turn.turnId, entry.turn.ordinal);
    if (entry.bindingId === recovery.binding.id)
      turnFloors.set(
        entry.turn.turnId,
        Math.max(turnFloors.get(entry.turn.turnId) ?? 0, entry.turn.revision),
      );
    const raw = object.parse(entry.source);
    let body: NativeHistoryObject;
    let metadata: NativeHistoryObject | null;
    let conflicts: NativeHistoryObject[] = [];
    if (raw.version === 2) {
      const content = turnContent.parse(raw);
      if (content.reducedTurn.id !== entry.turn.turnId)
        throw new Error(
          "Recovered native turn content has a different identity.",
        );
      ({ body, metadata, conflicts } = content.reducedTurn);
      for (const record of content.evidence) evidence(record);
    } else {
      body =
        raw.version === 1
          ? object.parse(raw.nativeTurn)
          : {
              id: entry.turn.turnId,
              status: entry.turn.status,
              startedAt:
                entry.turn.startedAtMs === null
                  ? null
                  : entry.turn.startedAtMs / 1000,
              completedAt:
                entry.turn.completedAtMs === null
                  ? null
                  : entry.turn.completedAtMs / 1000,
            };
      metadata =
        raw.version === 1 && raw.history != null
          ? object.parse(raw.history)
          : null;
      evidence({
        recordId: recordId(
          JSON.stringify([
            entry.bindingId,
            entry.turn.turnId,
            entry.turn.revision,
          ]),
        ),
        method: "cantrip/archive/turn-source",
        params: {
          turnId: entry.turn.turnId,
          bindingId: entry.bindingId,
          workerId: entry.workerId,
          source: raw,
        },
      });
    }
    if (
      body.id !== entry.turn.turnId ||
      (body.status !== undefined && body.status !== entry.turn.status) ||
      (metadata?.turnId !== undefined && metadata.turnId !== entry.turn.turnId)
    )
      throw new Error(
        "Recovered native turn fields disagree with their protected header.",
      );
    const list = candidates.get(entry.turn.turnId) ?? [];
    list.push({ body, metadata, conflicts });
    candidates.set(entry.turn.turnId, list);
  }
  for (const [id, list] of candidates) {
    const turn = turns.get(id)!;
    turn.body = consensus(list.map((value) => value.body));
    const metadata = list.flatMap((value) =>
      value.metadata ? [value.metadata] : [],
    );
    turn.metadata = metadata.length ? consensus(metadata, true) : null;
    const conflicts = [
      ...list.flatMap((value) => value.conflicts),
      ...list
        .filter((value) => !isDeepStrictEqual(value.body, turn.body))
        .map((value) => value.body),
      ...metadata
        .filter((value) => !isDeepStrictEqual(value, turn.metadata))
        .map((value) => ({ cantripArchiveMetadata: value })),
    ];
    turn.conflicts = conflicts.filter(
      (value, index) =>
        !conflicts
          .slice(0, index)
          .some((prior) => isDeepStrictEqual(prior, value)),
    );
  }
  const items = recovery.items.map((entry) => {
    if (entry.identity.threadId !== source.threadId)
      throw new Error("Recovered native item belongs to another thread.");
    const turn = ensureTurn(entry.identity.turnId, entry.order.turn);
    // Canonical item order wins over a foreign binding's aggregate ordinal.
    turn.ordinal = entry.order.turn;
    const publication = {
      identity: entry.identity,
      revision: Math.max(
        entry.revision,
        itemFloors.get(identityKey(entry.identity)) ?? 0,
      ),
      fingerprint: null,
      canonicalRevision: entry.revision,
      canonicalState: entry.state,
    };
    if (!entry.source || !entry.sourceCurrent) {
      evidence({
        recordId: recordId(`missing:${entry.key}:${entry.revision}`),
        method: "cantrip/archive/item-source-unavailable",
        params: {
          turnId: entry.identity.turnId,
          identity: entry.identity,
          revision: entry.revision,
          sourceRevision: entry.sourceRevision,
        },
      });
      return publication;
    }
    const item = nativeHistoryStateItemSchema.parse(entry.source);
    if (
      item.id !== entry.identity.itemId ||
      item.identityKind !== entry.identity.identityKind
    )
      throw new Error(
        "Recovered native item content has a different identity.",
      );
    item.ordinal = entry.order.item;
    const previous = turn.items.find(
      (value) =>
        value.id === item.id && value.identityKind === item.identityKind,
    );
    // Current renderers emit one component per item. Refuse contradictory
    // component sources instead of guessing which canonical component to erase.
    if (previous && !isDeepStrictEqual(previous, item))
      throw new Error(
        "Canonical components disagree on their recovered native source.",
      );
    if (!previous) turn.items.push(item);
    return {
      ...publication,
      sourceFingerprint: nativeHistorySourceFingerprint(
        item,
        turn.ordinal,
        item.ordinal,
      ),
    };
  });
  source.turns = [...turns.values()].sort(
    (a, b) =>
      a.ordinal - b.ordinal ||
      Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
  );
  for (const turn of source.turns)
    turn.items.sort(
      (a, b) =>
        a.ordinal - b.ordinal ||
        Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
    );
  return nativeHistoryProjectorStateSchema.parse({
    version: 1,
    source,
    items,
    turns: [...turnFloors].map(([turnId, revision]) => ({
      turnId,
      revision,
      fingerprint: null,
    })),
  });
}
