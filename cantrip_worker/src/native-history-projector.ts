import { createHash } from "node:crypto";
import { z } from "zod";
import {
  nativeHistoryBindingSchema,
  nativeHistoryItemIdentitySchema,
  nativeHistoryTurnSchema,
  type NativeHistoryBinding,
  type NativeHistoryPreparedBatch,
  type NativeHistoryResolve,
} from "@cantrip/protocol";
import type { NativeHistoryProjection } from "./native-history-projection.js";
import type { NativeHistoryClient } from "./native-history-client.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";
import {
  nativeHistoryStateSchema,
  type NativeHistoryStateItem,
  type NativeHistoryStateTurn,
} from "./native-history-state.js";
import { reduceNativeHistory } from "./native-history-reducer.js";
import {
  renderNativeHistoryItem,
  type NativeHistoryRenderContext,
  type NativeHistoryRenderedItem,
} from "./native-history-render.js";
import { prepareNativeHistoryRenderedItem } from "./native-history-prepare-item.js";
import { protectNativeHistoryTurnMetadata } from "./native-history-turn-content.js";

const publication = z.object({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  // Only restored publications use this marker to retain unchanged UI/attachments.
  sourceFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});
export const nativeHistoryProjectorStateSchema = z
  .object({
    version: z.literal(1),
    source: nativeHistoryStateSchema,
    items: z.array(
      publication
        .extend({
          identity: nativeHistoryItemIdentitySchema,
          canonicalRevision: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER)
            .optional(),
          canonicalState: z
            .enum(["started", "completed", "unknown"])
            .optional(),
        })
        .strict(),
    ),
    turns: z.array(publication.extend({ turnId: z.string().min(1) }).strict()),
  })
  .strict();
type Project = Parameters<typeof NativeHistoryProjection.open>[0]["project"];
type PreparedItem = NativeHistoryPreparedBatch["items"][number];
type Materialization = {
  inputParts?: NativeHistoryRenderContext["inputParts"];
  attachments: PreparedItem["attachments"];
};
type TurnContext = Omit<NativeHistoryStateTurn, "items">;
interface Options {
  binding: NativeHistoryBinding;
  service: WorkerEncryptionService;
  client: Pick<NativeHistoryClient, "resolve">;
  /** Refresh shared retained evidence once per source page, not per item. */
  prepare?(): Promise<void>;
  /** Read canonical recovery state only before the first durable local stage. */
  bootstrap?(): Promise<unknown>;
  /** Resolve verified presentation/child scope without reading attachment bytes. */
  context(
    item: NativeHistoryStateItem,
    turn: TurnContext,
  ): Promise<
    Omit<NativeHistoryRenderContext, "threadId" | "turnId" | "inputParts">
  >;
  /** Authorized files only, after identity resolution. Preserved GUI inputs skip
   * this callback and retain existing references without claiming a replica. A failure
   * leaves the source page pending; no guessed scope or attachment is emitted. */
  materialize(
    item: NativeHistoryStateItem,
    turn: TurnContext,
    context: Omit<
      NativeHistoryRenderContext,
      "threadId" | "turnId" | "inputParts"
    >,
    publishedAttachments?: PreparedItem["attachments"],
  ): Promise<Materialization>;
  /** Resolve provenance from admitted commands/queue claims. Native item strings
   * or matching text alone are not authority to alias existing GUI messages. */
  associate(
    item: NativeHistoryRenderedItem,
    turn: TurnContext,
  ): Promise<NativeHistoryResolve["items"][number]["association"]>;
  maxItemsPerBatch?: number;
  signal?: AbortSignal;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const fingerprint = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function nativeHistorySourceFingerprint(
  item: NativeHistoryStateItem,
  turnOrdinal: number,
  itemOrdinal: number,
) {
  return fingerprint({
    source: { ...item, origin: undefined },
    turnOrdinal,
    itemOrdinal,
  });
}
const identityKey = (identity: PreparedItem["identity"]) => canonical(identity);
const millis = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value * 1000 : null;

/** The actual source-to-canonical preparation step. NativeHistoryProjection owns
 * the encrypted stage, immutable retry bytes, receipts and checkpoint. This
 * closure owns no mutable revision counter and never dispatches native input. */
export function createNativeHistoryProjector(options: Options): Project {
  const binding = nativeHistoryBindingSchema.parse(options.binding);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(512)
    .parse(options.maxItemsPerBatch ?? 512);
  return async (records, previous) => {
    options.signal?.throwIfAborted();
    const initial = previous ?? (await options.bootstrap?.());
    options.signal?.throwIfAborted();
    const saved =
      initial == null ? null : nativeHistoryProjectorStateSchema.parse(initial);
    const source = reduceNativeHistory(
      saved?.source,
      records,
      binding.threadId,
    );
    await options.prepare?.();
    options.signal?.throwIfAborted();
    const state = nativeHistoryProjectorStateSchema.parse({
      version: 1,
      source,
      items: saved?.items ?? [],
      turns: saved?.turns ?? [],
    });
    const publications = new Map(
      state.items.map((entry) => [identityKey(entry.identity), entry]),
    );
    const restoredBySource = new Map<string, typeof state.items>();
    for (const entry of state.items) {
      const key = JSON.stringify([
        entry.identity.turnId,
        entry.identity.itemId,
        entry.identity.identityKind,
      ]);
      const group = restoredBySource.get(key) ?? [];
      group.push(entry);
      restoredBySource.set(key, group);
    }
    const turnPublications = new Map(
      state.turns.map((entry) => [entry.turnId, entry]),
    );
    const batches: NativeHistoryPreparedBatch[] = [];
    let batch: NativeHistoryPreparedBatch = { items: [], turns: [] };
    const flush = () => {
      if (batch.items.length || batch.turns.length) batches.push(batch);
      batch = { items: [], turns: [] };
    };
    const pending: Array<{
      draft: NativeHistoryRenderedItem;
      association: NativeHistoryResolve["items"][number]["association"];
      item: NativeHistoryStateItem;
      turn: TurnContext;
      context: NativeHistoryRenderContext;
      order: PreparedItem["order"];
    }> = [];
    const flushItems = async () => {
      if (!pending.length) return;
      options.signal?.throwIfAborted();
      const mappings = await options.client.resolve(
        {
          chatId: binding.chatId,
          bindingId: binding.id,
          items: pending.map(({ draft, association }) => ({
            identity: draft.identity,
            association,
          })),
        },
        options.signal,
      );
      if (mappings.length !== pending.length)
        throw new Error("Native history resolution omitted item mappings.");
      for (const [index, entry] of pending.entries()) {
        options.signal?.throwIfAborted();
        const mapping = mappings[index]!;
        if (identityKey(mapping.identity) !== identityKey(entry.draft.identity))
          throw new Error(
            "Native history resolution returned an unrelated item mapping.",
          );
        const material = mapping.preservedInput
          ? { attachments: [] }
          : await options.materialize(
              structuredClone(entry.item),
              structuredClone(entry.turn),
              structuredClone(entry.context),
              mapping.attachments,
            );
        const draft = mapping.preservedInput
          ? entry.draft
          : renderNativeHistoryItem(entry.item, {
              ...entry.context,
              inputParts: material.inputParts,
            })[entry.order.component];
        if (
          !draft ||
          identityKey(draft.identity) !== identityKey(mapping.identity)
        )
          throw new Error(
            "Native history materialization changed the item identity.",
          );
        const digest = fingerprint({
          draft: { ...draft, source: { ...draft.source, origin: undefined } },
          order: entry.order,
          attachments: material.attachments,
        });
        const prior = publications.get(identityKey(draft.identity));
        if (prior?.fingerprint === digest) continue;
        const revision = (prior?.revision ?? 0) + 1;
        const prepared = await prepareNativeHistoryRenderedItem({
          service: options.service,
          binding,
          rendered: draft,
          mapping,
          revision,
          order: entry.order,
          attachments: material.attachments,
        });
        // This basis belongs to the source state, before resolution or
        // materialization can race a concurrent writer. Never stamp a newer
        // resolve result onto content prepared from an older observation.
        prepared.expectedRevision =
          prior?.canonicalRevision ?? prior?.revision ?? 0;
        if (batch.items.length >= limit) flush();
        batch.items.push(prepared);
        publications.set(identityKey(entry.draft.identity), {
          identity: entry.draft.identity,
          revision,
          fingerprint: digest,
          canonicalRevision: revision,
          canonicalState: prepared.state,
        });
      }
      pending.length = 0;
    };
    for (const turn of source.turns) {
      const { items: _items, ...reducedTurn } = turn;
      for (const item of turn.items) {
        options.signal?.throwIfAborted();
        const restored =
          restoredBySource.get(
            JSON.stringify([turn.id, item.id, item.identityKind]),
          ) ?? [];
        const sourceFingerprint = nativeHistorySourceFingerprint(
          item,
          turn.ordinal,
          item.ordinal,
        );
        if (
          restored.length &&
          item.lifecycle !== "completed" &&
          restored.every((entry) => entry.canonicalState === "completed")
        )
          continue; // Retain stale source evidence without replacing terminal UI.
        if (
          restored.length &&
          restored.every(
            (entry) =>
              entry.fingerprint === null &&
              entry.sourceFingerprint === sourceFingerprint,
          )
        )
          continue;
        // Context and association cannot mutate the reducer checkpoint. File
        // materialization waits for the authoritative identity mapping below.
        const context = {
          ...(await options.context(
            structuredClone(item),
            structuredClone(reducedTurn),
          )),
          threadId: binding.threadId,
          turnId: turn.id,
        };
        const rendered = renderNativeHistoryItem(item, context);
        for (const [component, draft] of rendered.entries()) {
          const order = { turn: turn.ordinal, item: item.ordinal, component };
          const prior = publications.get(identityKey(draft.identity));
          // An unchanged reference-only/plain item needs neither a reservation
          // nor attachment I/O. Materialized files have a different fingerprint
          // and still run through verification/restoration on reobservation.
          if (
            prior?.fingerprint ===
            fingerprint({
              draft: {
                ...draft,
                source: { ...draft.source, origin: undefined },
              },
              order,
              attachments: [],
            })
          )
            continue;
          const association = prior
            ? { kind: "existing" as const }
            : draft.identity.component === "user" &&
                draft.identity.identityKind === "canonical" &&
                typeof draft.source.body.clientId === "string" &&
                draft.source.body.clientId.length > 0
              ? {
                  kind: "observed-input" as const,
                  clientUserMessageId: draft.source.body.clientId,
                }
              : await options.associate(
                  structuredClone(draft),
                  structuredClone(reducedTurn),
                );
          pending.push({
            draft,
            association,
            order,
            item,
            turn: reducedTurn,
            context,
          });
          if (pending.length >= limit) await flushItems();
        }
      }
      // Item-only observations do not establish a containing turn's outcome.
      // Preserve unknown turn headers in state until actual turn evidence arrives.
      const status = nativeHistoryTurnSchema.shape.status.safeParse(
        turn.body.status,
      );
      if (!status.success) continue;
      const evidence = source.evidence.filter((entry) => {
        const rawTurn = entry.params.turn;
        return (
          entry.params.turnId === turn.id ||
          (rawTurn &&
            typeof rawTurn === "object" &&
            !Array.isArray(rawTurn) &&
            rawTurn.id === turn.id) ||
          entry.method === "thread/read"
        );
      });
      const content = { version: 2, reducedTurn, evidence };
      const digest = fingerprint({
        ...content,
        reducedTurn: { ...reducedTurn, origin: undefined },
        // Repeated identical reads retain all record IDs locally; they do not
        // change the aggregate's semantic evidence or require reencryption.
        evidence: [
          ...new Set(
            evidence.map(({ method, params }) => canonical({ method, params })),
          ),
        ],
      });
      const prior = turnPublications.get(turn.id);
      if (prior?.fingerprint === digest) continue;
      const revision = (prior?.revision ?? 0) + 1;
      const prepared = await protectNativeHistoryTurnMetadata({
        service: options.service,
        binding,
        content,
        header: {
          threadId: binding.threadId,
          turnId: turn.id,
          revision,
          ordinal: turn.ordinal,
          status: status.data,
          startedAtMs: millis(turn.body.startedAt),
          completedAtMs: millis(turn.body.completedAt),
        },
      });
      if (batch.turns.length >= limit) flush();
      batch.turns.push(prepared);
      turnPublications.set(turn.id, {
        turnId: turn.id,
        revision,
        fingerprint: digest,
      });
    }
    await flushItems();
    flush();
    options.signal?.throwIfAborted();
    return {
      state: nativeHistoryProjectorStateSchema.parse({
        ...state,
        items: [...publications.values()],
        turns: [...turnPublications.values()],
      }),
      batches,
    };
  };
}
