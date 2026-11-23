import { nativeTurnModelAttributionSchema } from "@cantrip/protocol";
import { isDeepStrictEqual } from "node:util";
import { nativeInitialTurnSettingsSchema } from "@cantrip/protocol";
import type { NativeHistorySourceJournal } from "./native-history-source-journal.js";
import {
  nativeHistoryStateSchema,
  type NativeHistoryState,
  type NativeHistoryStateTurn,
  type NativeHistoryStateItem,
  type NativeHistoryCandidate,
  type NativeHistoryOrigin,
  type NativeHistoryObject,
} from "./native-history-state.js";
import type { CodexNativeHistorySnapshot } from "./codex/native-history.js";

type Page = Awaited<ReturnType<NativeHistorySourceJournal["read"]>>;
const object = (value: unknown): NativeHistoryObject | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as NativeHistoryObject)
    : null;
const time = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const terminal = (value: unknown) =>
  ["completed", "failed", "interrupted"].includes(String(value));
const itemMaterial = ({
  origin: _origin,
  revision: _revision,
  ...item
}: NativeHistoryStateItem) => item;
const covers = (a: NativeHistoryObject, b: NativeHistoryObject) =>
  Object.keys(b).every(
    (key) => Object.hasOwn(a, key) && isDeepStrictEqual(a[key], b[key]),
  );
const concurrent = (previous: NativeHistoryOrigin, next: NativeHistoryOrigin) =>
  next.kind === "snapshot" &&
  previous.generation === next.generation &&
  previous.sequence > next.sequence;
const nativeOrder = (
  previous: NativeHistoryOrigin,
  next: NativeHistoryOrigin,
) => {
  const a = previous.nativeCursor;
  const b = next.nativeCursor;
  if (!a || !b || a.epoch !== b.epoch) return null;
  return BigInt(b.sequence) < BigInt(a.sequence)
    ? -1
    : BigInt(b.sequence) > BigInt(a.sequence)
      ? 1
      : 0;
};

function ensureTurn(
  state: NativeHistoryState,
  turnId: string,
  origin: NativeHistoryOrigin,
) {
  let turn = state.turns.find((entry) => entry.id === turnId);
  if (!turn) {
    turn = {
      id: turnId,
      ordinal: state.turns.length,
      revision: 1,
      body: { id: turnId },
      metadata: null,
      origin,
      items: [],
      conflicts: [],
    };
    state.turns.push(turn);
  }
  return turn;
}

/** Initial settings belong to this exact turn, not the current thread selection.
 * Omission by an older snapshot cannot erase evidence. Conflicting immutable
 * captures remain explicit and cannot become a last-writer/default selection. */
function retainInitialSettings(turn: NativeHistoryStateTurn, input: unknown) {
  const parsed = nativeInitialTurnSettingsSchema.safeParse(input);
  if (!parsed.success) return;
  const next = parsed.data;
  const previous = turn.metadata?.initialSettings;
  const conflict = turn.conflicts.some(
    (entry) =>
      Object.hasOwn(entry, "initialSettings") ||
      entry.initialSettingsConflict === true,
  );
  if (conflict || (previous && !isDeepStrictEqual(previous, next))) {
    for (const value of [previous, next]) {
      if (!value) continue;
      const candidate = { initialSettings: value } as NativeHistoryObject;
      if (
        !turn.conflicts.some((entry) => isDeepStrictEqual(entry, candidate))
      ) {
        turn.conflicts.push(candidate);
        turn.revision++;
      }
    }
    if (turn.metadata && Object.hasOwn(turn.metadata, "initialSettings")) {
      delete turn.metadata.initialSettings;
      turn.revision++;
    }
  } else if (!previous) {
    turn.metadata = { ...turn.metadata, initialSettings: next };
    turn.revision++;
  }
}

function applyItem(
  turn: NativeHistoryStateTurn,
  itemId: string,
  identityKind: "canonical" | "legacy",
  next: NativeHistoryCandidate,
  initial = false,
) {
  const previous = turn.items.find(
    (entry) => entry.id === itemId && entry.identityKind === identityKind,
  );
  if (!previous) {
    turn.items.push({
      id: itemId,
      identityKind,
      revision: 1,
      ordinal: turn.items.length,
      ...next,
      conflicts: [],
    });
    return;
  }
  const before = structuredClone(itemMaterial(previous));
  const ordering = nativeOrder(previous.origin, next.origin);
  const stale =
    ordering === null ? concurrent(previous.origin, next.origin) : ordering < 0;
  const downgrade =
    (previous.lifecycle === "completed" && next.lifecycle !== "completed") ||
    (previous.completeBody && !next.completeBody);
  // Retained native snapshots materialize item lifecycle payloads, not every
  // live delta. Even a read begun after a delta can return the empty start body.
  // Preserve the same-transport live base and its ordering provenance; only a
  // completion (or a future explicit native content watermark) can supersede it.
  // New snapshot-only fields may enrich the item without replacing live fields.
  if (
    next.origin.kind === "snapshot" &&
    !next.origin.nativeCursor &&
    next.lifecycle === "started" &&
    previous.lifecycle === "started" &&
    previous.origin.kind === "notification" &&
    previous.origin.generation === next.origin.generation
  ) {
    next.body = { ...next.body, ...previous.body };
    next.origin = previous.origin;
  }
  if (initial && previous.lifecycle === "started") {
    if (
      previous.origin.kind === "snapshot" &&
      !isDeepStrictEqual(previous.body, next.body)
    )
      next.origin = previous.origin;
    next.body = { ...next.body, ...previous.body };
  }
  if (!stale && !downgrade) {
    let replace = true;
    if (
      previous.lifecycle === "completed" &&
      next.lifecycle === "completed" &&
      !isDeepStrictEqual(previous.body, next.body)
    ) {
      if (ordering !== null && ordering !== 0) replace = ordering > 0;
      else if (covers(previous.body, next.body))
        replace = false; // Do not erase omitted fields.
      else if (covers(next.body, previous.body)) replace = true;
      else if (
        previous.completedAtMs !== null &&
        next.completedAtMs !== null &&
        previous.completedAtMs !== next.completedAtMs
      )
        replace = next.completedAtMs > previous.completedAtMs;
      else if (
        next.origin.kind === "notification" &&
        previous.origin.generation === next.origin.generation &&
        next.origin.sequence > previous.origin.sequence
      )
        replace = true;
      else {
        replace = false;
        if (
          !previous.conflicts.some(
            (entry) =>
              isDeepStrictEqual(entry.body, next.body) &&
              entry.lifecycle === next.lifecycle,
          )
        )
          previous.conflicts.push(next);
      }
    }
    if (replace) {
      previous.body = next.body;
      previous.lifecycle =
        next.lifecycle === "unknown" ? previous.lifecycle : next.lifecycle;
      previous.completeBody = next.completeBody;
      if (next.completedAtMs !== null)
        previous.completedAtMs =
          previous.completedAtMs === null
            ? next.completedAtMs
            : Math.max(previous.completedAtMs, next.completedAtMs);
      previous.origin = next.origin;
    }
  }
  // Unavailable snapshot timestamps are not zero and do not erase measured data.
  previous.startedAtMs ??= next.startedAtMs;
  if (previous.completedAtMs === null && previous.lifecycle === "completed")
    previous.completedAtMs = next.completedAtMs;
  if (!isDeepStrictEqual(before, itemMaterial(previous))) previous.revision++;
}

function applyTurn(
  turn: NativeHistoryStateTurn,
  raw: NativeHistoryObject,
  origin: NativeHistoryOrigin,
  completion = false,
) {
  if (concurrent(turn.origin, origin)) return;
  const { items: _items, ...body } = raw;
  const before = structuredClone({
    body: turn.body,
    conflicts: turn.conflicts,
    terminalNotification: turn.terminalNotification,
  });
  const confirmed =
    turn.terminalNotification === turn.body.status &&
    turn.terminalNotification !== undefined;
  const actualCompletion = completion && terminal(body.status);
  let replace = true;
  let terminalCorrection = false;
  if (
    terminal(turn.body.status) &&
    terminal(body.status) &&
    turn.body.status !== body.status
  ) {
    // Native reads may synthesize interruption while core/listener state is
    // transitioning. A real completion, or a retained completion timestamp,
    // resolves that snapshot-only outcome. Conflicting actual completions stay
    // explicit; neither a late start nor a snapshot can undo a real Stop.
    replace =
      !confirmed &&
      (actualCompletion ||
        (time(body.completedAt) !== null &&
          time(turn.body.completedAt) === null));
    terminalCorrection = replace;
    const conflict = replace ? structuredClone(turn.body) : body;
    if (!turn.conflicts.some((entry) => isDeepStrictEqual(entry, conflict)))
      turn.conflicts.push(conflict);
  }
  if (replace) {
    if (terminal(turn.body.status) && !terminal(body.status))
      delete body.status;
    for (const [key, value] of Object.entries(body)) {
      if (
        value !== null ||
        !Object.hasOwn(turn.body, key) ||
        ((actualCompletion || terminalCorrection) &&
          ["error", "completedAt", "durationMs"].includes(key))
      )
        Object.defineProperty(turn.body, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
    if (actualCompletion)
      turn.terminalNotification = body.status as NonNullable<
        NativeHistoryStateTurn["terminalNotification"]
      >;
    turn.origin = origin;
  }
  if (
    !isDeepStrictEqual(before, {
      body: turn.body,
      conflicts: turn.conflicts,
      terminalNotification: turn.terminalNotification,
    })
  )
    turn.revision++;
}

/** Insert historical prefixes/gaps without deleting live-only entries. If an
 * older snapshot contradicts existing relative order, retain that order; explicit
 * rollback/fork interpretation is a separate requirement, not a guessed delete. */
function order<T>(
  existing: T[],
  observed: string[],
  key: (entry: T) => string,
) {
  const remaining = [...existing];
  const result: T[] = [];
  for (const observedId of observed) {
    const index = remaining.findIndex((entry) => key(entry) === observedId);
    if (index < 0) continue;
    // Entries already known before this observed anchor keep their chronology.
    result.push(...remaining.splice(0, index + 1));
  }
  return [...result, ...remaining];
}

function snapshot(
  state: NativeHistoryState,
  value: CodexNativeHistorySnapshot,
  origin: NativeHistoryOrigin,
) {
  const oldTurnIds = new Set(state.turns.map((turn) => turn.id));
  for (const rawTurn of value.thread.turns) {
    const turn = ensureTurn(state, rawTurn.id, origin);
    // The pinned runtime can read an in-progress record before its Running
    // status notification and infer interruption. Its exact live current ID
    // disproves that inference; a retained terminal timestamp still wins.
    const provisional =
      rawTurn.status === "interrupted" &&
      time(rawTurn.completedAt) === null &&
      value.history?.currentTurnState === "live" &&
      value.history.currentTurnId === rawTurn.id;
    if (provisional) {
      const { items: _items, ...observed } = rawTurn;
      const conflict = {
        inferredInterruption: observed,
      } as NativeHistoryObject;
      if (!turn.conflicts.some((entry) => isDeepStrictEqual(entry, conflict))) {
        turn.conflicts.push(conflict);
        turn.revision++;
      }
    }
    applyTurn(
      turn,
      provisional
        ? ({ ...rawTurn, status: "inProgress" } as NativeHistoryObject)
        : (rawTurn as NativeHistoryObject),
      origin,
    );
    const metadata =
      value.history?.turns.find((entry) => entry.turnId === rawTurn.id) ?? null;
    if (metadata?.initialSettingsConflict) {
      if (
        !turn.conflicts.some((entry) => entry.initialSettingsConflict === true)
      ) {
        turn.conflicts.push({ initialSettingsConflict: true });
        turn.revision++;
      }
      if (turn.metadata?.initialSettings) {
        turn.conflicts.push({ initialSettings: turn.metadata.initialSettings });
        delete turn.metadata.initialSettings;
        turn.revision++;
      }
    }
    retainInitialSettings(turn, metadata?.initialSettings);
    if (metadata && !concurrent(turn.origin, origin)) {
      // Retention can shrink or an older runtime can omit context. Neither
      // erases exact settings already observed for this native turn. Keep
      // distinct candidates; their array order is not a last-writer choice.
      const contexts = Array.isArray(turn.metadata?.contexts)
        ? [...turn.metadata.contexts]
        : [];
      for (const context of metadata.contexts ?? [])
        if (!contexts.some((previous) => isDeepStrictEqual(previous, context)))
          contexts.push(context as NativeHistoryObject);
      const { initialSettings: _observedInitialSettings, ...observedMetadata } =
        metadata;
      const retained = {
        ...observedMetadata,
        ...(turn.metadata?.cantripModelAttribution
          ? { cantripModelAttribution: turn.metadata.cantripModelAttribution }
          : {}),
        ...(contexts.length ? { contexts } : {}),
        ...(turn.metadata?.initialSettings
          ? { initialSettings: turn.metadata.initialSettings }
          : {}),
      };
      if (!isDeepStrictEqual(turn.metadata, retained)) {
        turn.metadata = retained as NativeHistoryObject;
        turn.revision++;
      }
    }
    const kind = metadata?.source ?? "legacy";
    const oldKeys = new Set(
      turn.items.map((item) => `${item.identityKind}:${item.id}`),
    );
    for (const item of rawTurn.items) {
      const live = value.history?.live?.items.find(
        (live) => live.turnId === rawTurn.id && live.item.id === item.id,
      );
      if (live) {
        applyItem(turn, item.id, "canonical", {
          body: live.item as NativeHistoryObject,
          lifecycle: live.state,
          completeBody: true,
          startedAtMs: live.startedAtMs,
          completedAtMs: live.completedAtMs,
          origin: { ...origin, nativeCursor: live.cursor },
        });
        continue;
      }
      const evidence = metadata?.items.find(
        (entry) => entry.itemId === item.id,
      );
      applyItem(turn, item.id, kind, {
        body: item as NativeHistoryObject,
        lifecycle: evidence?.state ?? "unknown",
        completeBody:
          rawTurn.itemsView !== "summary" && rawTurn.itemsView !== "notLoaded",
        startedAtMs: evidence?.startedAtMs ?? null,
        completedAtMs: evidence?.completedAtMs ?? null,
        origin,
      });
    }
    // New historical entries are positioned by snapshot order, not appended
    // behind a live turn/item just because capture attached in the middle.
    const observed = rawTurn.items.map((item) => `${kind}:${item.id}`);
    const inserted = turn.items.filter(
      (item) => !oldKeys.has(`${item.identityKind}:${item.id}`),
    );
    const retained = turn.items.filter((item) =>
      oldKeys.has(`${item.identityKind}:${item.id}`),
    );
    for (const entry of inserted) {
      const position = observed.indexOf(`${entry.identityKind}:${entry.id}`);
      const next = observed
        .slice(position + 1)
        .find((candidate) =>
          retained.some(
            (item) => `${item.identityKind}:${item.id}` === candidate,
          ),
        );
      const anchor = next
        ? retained.findIndex(
            (item) => `${item.identityKind}:${item.id}` === next,
          )
        : retained.length;
      retained.splice(anchor, 0, entry);
    }
    turn.items = order(
      retained,
      observed,
      (item) => `${item.identityKind}:${item.id}`,
    );
  }
  const observed = value.thread.turns.map((turn) => turn.id);
  const inserted = state.turns.filter((turn) => !oldTurnIds.has(turn.id));
  const retained = state.turns.filter((turn) => oldTurnIds.has(turn.id));
  for (const turn of inserted) {
    const next = observed
      .slice(observed.indexOf(turn.id) + 1)
      .find((candidate) => retained.some((item) => item.id === candidate));
    retained.splice(
      next ? retained.findIndex((item) => item.id === next) : retained.length,
      0,
      turn,
    );
  }
  state.turns = order(retained, observed, (turn) => turn.id);
  for (const live of value.history?.live?.items ?? []) {
    if (
      value.thread.turns.some(
        (turn) =>
          turn.id === live.turnId &&
          turn.items.some((item) => item.id === live.item.id),
      )
    )
      continue;
    const turn = ensureTurn(state, live.turnId, origin);
    applyItem(turn, live.item.id, "canonical", {
      body: live.item as NativeHistoryObject,
      lifecycle: live.state,
      completeBody: true,
      startedAtMs: live.startedAtMs,
      completedAtMs: live.completedAtMs,
      origin: { ...origin, nativeCursor: live.cursor },
    });
  }
}

function delta(
  turn: NativeHistoryStateTurn,
  params: NativeHistoryObject,
  method: string,
  origin: NativeHistoryOrigin,
) {
  if (!id(params.itemId)) return false;
  const kind =
    method === "item/agentMessage/delta"
      ? "agentMessage"
      : method === "item/commandExecution/outputDelta"
        ? "commandExecution"
        : method === "item/fileChange/patchUpdated"
          ? "fileChange"
          : method.startsWith("item/reasoning/summary")
            ? "reasoning"
            : null;
  if (!kind) return false;
  const item = turn.items.find(
    (entry) => entry.id === params.itemId && entry.identityKind === "canonical",
  );
  if (item?.lifecycle === "completed") return true;
  const cursor = origin.nativeCursor;
  const previousCursor = item?.origin.nativeCursor;
  if (cursor && previousCursor && cursor.epoch === previousCursor.epoch) {
    if (BigInt(cursor.sequence) <= BigInt(previousCursor.sequence)) return true;
    // A predecessor mismatch means at least one item update is missing. Keep
    // the raw delta for reconciliation; never guess a prefix or replay input.
    if (cursor.previousSequence !== previousCursor.sequence) return false;
  } else if (cursor || previousCursor) return false;
  // A read response is not a native delta watermark: its body may already
  // contain a delta whose notification arrives later. Retain that raw evidence
  // for reconciliation rather than append it twice to an uncertain base.
  if (
    item &&
    !previousCursor &&
    (item.origin.generation !== origin.generation ||
      item.origin.kind === "snapshot")
  )
    return false;
  const body: NativeHistoryObject = structuredClone(
    item?.body ?? { id: params.itemId, type: kind },
  );
  if (method === "item/fileChange/patchUpdated") {
    if (!Array.isArray(params.changes)) return false;
    body.changes = params.changes;
  } else if (kind === "reasoning") {
    if (
      !Number.isSafeInteger(params.summaryIndex) ||
      Number(params.summaryIndex) < 0
    )
      return false;
    // Sparse summary deltas are kept by index; do not allocate an untrusted-sized
    // array or truncate content at the former presentation limit of 100 parts.
    const parts =
      object(body.summaryParts) ??
      Object.fromEntries(
        (Array.isArray(body.summary) ? body.summary : []).flatMap(
          (value, index) =>
            typeof value === "string" ? [[String(index), value]] : [],
        ),
      );
    const index = String(params.summaryIndex);
    if (method === "item/reasoning/summaryTextDelta") {
      if (typeof params.delta !== "string") return false;
      parts[index] = String(parts[index] ?? "") + params.delta;
    } else if (method === "item/reasoning/summaryPartAdded")
      parts[index] ??= "";
    else return false;
    body.summaryParts = parts;
  } else {
    if (typeof params.delta !== "string") return false;
    const field = kind === "agentMessage" ? "text" : "aggregatedOutput";
    body[field] =
      (typeof body[field] === "string" ? body[field] : "") + params.delta;
  }
  applyItem(turn, params.itemId, "canonical", {
    body,
    lifecycle: "started",
    completeBody: item?.completeBody ?? false,
    startedAtMs: item?.startedAtMs ?? null,
    completedAtMs: null,
    origin,
  });
  return true;
}

/** Pure worker-local reduction; never performs input or publishes plaintext.
 * Feed the result through NativeHistoryProjection so revisions survive restart
 * and only canonical ACK consumes the corresponding source page. */
export function reduceNativeHistory(
  previous: unknown,
  records: Page,
  threadId: string,
): NativeHistoryState {
  const state =
    previous == null
      ? nativeHistoryStateSchema.parse({
          version: 1,
          threadId,
          turns: [],
          evidence: [],
          notifications: [],
        })
      : nativeHistoryStateSchema.parse(structuredClone(previous));
  if (state.threadId !== threadId)
    throw new Error("Native history state belongs to another thread.");
  for (const record of records) {
    const frame = record.frame;
    if (frame.threadId !== threadId)
      throw new Error("Native history source belongs to another thread.");
    if (frame.kind === "snapshot") {
      if (state.evidence.some((entry) => entry.recordId === record.recordId))
        continue;
      snapshot(state, frame.snapshot, {
        kind: "snapshot",
        generation: frame.generation,
        sequence: frame.readBarrierSequence,
      });
      const { thread, history, ...extra } = frame.snapshot;
      const { turns: _turns, ...threadHeader } = thread;
      const { turns: _metadataTurns, live, ...historyHeader } = history ?? {};
      state.evidence.push({
        recordId: record.recordId,
        method: "thread/read",
        params: {
          ...extra,
          thread: threadHeader,
          history:
            history === null
              ? null
              : {
                  ...historyHeader,
                  ...(live
                    ? {
                        live: {
                          epoch: live.epoch,
                          throughSequence: live.throughSequence,
                        },
                      }
                    : {}),
                },
        } as NativeHistoryObject,
      });
      continue;
    }
    let boundary = state.notifications.find(
      (entry) => entry.generation === frame.generation,
    );
    if (boundary && frame.sequence <= boundary.sequence) continue;
    if (!boundary) {
      boundary = { generation: frame.generation, sequence: 0 };
      state.notifications.push(boundary);
    }
    boundary.sequence = frame.sequence;
    const origin: NativeHistoryOrigin = {
      kind: "notification",
      generation: frame.generation,
      sequence: frame.sequence,
      ...(frame.nativeCursor ? { nativeCursor: frame.nativeCursor } : {}),
    };
    const params = frame.params as NativeHistoryObject;
    const rawTurn = object(params.turn);
    const turnId = id(params.turnId)
      ? params.turnId
      : rawTurn && id(rawTurn.id)
        ? rawTurn.id
        : null;
    const turn = turnId ? ensureTurn(state, turnId, origin) : null;
    if (
      turn &&
      rawTurn &&
      ["turn/started", "turn/completed"].includes(frame.method)
    ) {
      applyTurn(turn, rawTurn, origin, frame.method === "turn/completed");
      if (frame.method === "turn/started") {
        retainInitialSettings(turn, params.initialSettings);
        const attribution = nativeTurnModelAttributionSchema.safeParse(
          params.cantripModelAttribution,
        );
        if (
          attribution.success &&
          attribution.data.threadId === state.threadId &&
          attribution.data.turnId === turn.id
        ) {
          const prior = turn.metadata?.cantripModelAttribution;
          if (!prior) {
            turn.metadata = {
              ...turn.metadata,
              cantripModelAttribution: attribution.data,
            };
            turn.revision++;
          } else if (!isDeepStrictEqual(prior, attribution.data)) {
            const conflict = { cantripModelAttribution: attribution.data };
            if (
              !turn.conflicts.some((value) =>
                isDeepStrictEqual(value, conflict),
              )
            ) {
              turn.conflicts.push(conflict);
              turn.revision++;
            }
          }
        }
      }
      for (const candidate of Array.isArray(rawTurn.items)
        ? rawTurn.items
        : []) {
        const item = object(candidate);
        if (item && id(item.id) && id(item.type))
          applyItem(turn, item.id, "canonical", {
            body: item,
            lifecycle: "unknown",
            completeBody:
              rawTurn.itemsView !== "summary" &&
              rawTurn.itemsView !== "notLoaded",
            startedAtMs: null,
            completedAtMs: null,
            origin,
          });
      }
      // Turn completion does not complete all its items; late child/tool events
      // remain individually live until their own lifecycle evidence arrives.
      continue;
    }
    const rawItem = object(params.item);
    if (
      turn &&
      rawItem &&
      id(rawItem.id) &&
      id(rawItem.type) &&
      ["item/started", "item/completed"].includes(frame.method)
    ) {
      applyItem(
        turn,
        rawItem.id,
        "canonical",
        {
          body: rawItem,
          lifecycle:
            frame.method === "item/completed" ? "completed" : "started",
          completeBody: true,
          startedAtMs: time(params.startedAtMs),
          completedAtMs: time(params.completedAtMs),
          origin,
        },
        frame.method === "item/started",
      );
      continue;
    }
    if (turn && delta(turn, params, frame.method, origin)) continue;
    state.evidence.push({
      recordId: record.recordId,
      method: frame.method,
      params,
    });
  }
  for (const [ordinal, turn] of state.turns.entries()) {
    if (turn.ordinal !== ordinal) {
      turn.ordinal = ordinal;
      turn.revision++;
    }
    for (const [itemOrdinal, item] of turn.items.entries()) {
      if (item.ordinal !== itemOrdinal) {
        item.ordinal = itemOrdinal;
        item.revision++;
      }
    }
  }
  return nativeHistoryStateSchema.parse(state);
}
