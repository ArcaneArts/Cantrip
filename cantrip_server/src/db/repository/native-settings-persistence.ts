import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  nativeCommandIntentSchema,
  nativeSettingsStateSchema,
  nativeSettingsIntentSchema,
  nativeCommandSessionSchema,
  nativeSettingsReadScopeSchema,
  protectedNativeSettingsSnapshotSchema,
  type NativeSettingsReadScope,
  type NativeSettingsObservationRequest,
  type NativeSettingsObservationReceipt,
  nativeSettingsObservationRequestSchema,
  type NativeSettingsState,
  type NativeSettingsBinding,
  type NativeCommandSession,
} from "@cantrip/protocol";
import * as schema from "../schema.js";
import type { RepositoryDatabase, RepositoryTransaction } from "./database.js";
import {
  emptyNativeSettingsState,
  bindNativeSettingsRead,
  observeNativeSettings,
  requestNativeSettings,
  settleNativeSettingsIntent,
} from "./native-settings-state.js";

import { lockNativeCommandChat } from "./native-command-lock.js";
import { NativeCommandError } from "./native-command-errors.js";
import { ChatRuntimeContextRepository } from "./chat-runtime-context.js";

type CommandRow = typeof schema.nativeCommands.$inferSelect;

export class NativeSettingsStateRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  /** Resolve the stored source against canonical routing, without reading native
   * settings or granting input authority. Admission and dispatch recheck it. */
  async resolveWriteBinding(
    ownerId: string,
    chatId: string,
    expectedBindingId: string,
  ): Promise<NativeSettingsBinding> {
    return this.database.transaction(async (tx) => {
      await lockNativeCommandChat(tx, ownerId, chatId);
      return assertNativeSettingsWriteBinding(
        tx,
        ownerId,
        chatId,
        expectedBindingId,
      );
    });
  }

  /** The server invokes an actual worker read outside the DB transaction. A late
   * read cannot replace a newer binding or cross a changed placement/account. */
  async refresh(
    ownerId: string,
    chatId: string,
    read: (scope: NativeSettingsReadScope) => Promise<unknown>,
  ): Promise<NativeSettingsState> {
    const before = await this.database.transaction(async (tx) => {
      await lockNativeCommandChat(tx, ownerId, chatId);
      const scope = await readScope(tx, ownerId, chatId);
      const state = await new NativeSettingsStateRepository(tx).get(
        ownerId,
        chatId,
      );
      return { scope, bindingId: state?.binding?.bindingId ?? null };
    });
    const snapshot = protectedNativeSettingsSnapshotSchema.parse(
      await read(before.scope),
    );
    if (
      snapshot.context.chatId !== chatId ||
      snapshot.context.workerId !== before.scope.workerId ||
      snapshot.context.threadId !== before.scope.threadId
    )
      throw new NativeCommandError(
        "settings-read-scope",
        "The settings read returned another native source.",
      );
    return this.database.transaction(async (tx) => {
      await lockNativeCommandChat(tx, ownerId, chatId);
      if (
        !isDeepStrictEqual(before.scope, await readScope(tx, ownerId, chatId))
      )
        throw new NativeCommandError(
          "settings-read-replaced",
          "The chat moved while its settings were being read.",
        );
      const [activation] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, chatId));
      if (
        activation?.active &&
        activation.runtimeGeneration &&
        activation.runtimeGeneration !== snapshot.context.runtimeGeneration
      )
        throw new NativeCommandError(
          "settings-read-replaced",
          "A different native runtime owns the current turn.",
        );
      return changeNativeSettingsState(tx, chatId, (state) => {
        if ((state.binding?.bindingId ?? null) !== before.bindingId)
          throw new NativeCommandError(
            "settings-read-replaced",
            "A newer settings read has already been published.",
          );
        const source = {
          ...before.scope,
          runtimeGeneration: snapshot.context.runtimeGeneration,
          nativeEpoch: snapshot.context.settingsVersion.epoch,
        };
        const { bindingId: existingId, ...existingSource } =
          state.binding ?? {};
        // Reading the same source must not revoke a concurrently prepared
        // settings write. Native revisions already order snapshots within it.
        const bindingId =
          existingId &&
          isDeepStrictEqual(existingSource, source) &&
          state.effective?.protectedContent.keyRevision ===
            snapshot.protectedContent.keyRevision
            ? existingId
            : randomUUID();
        return bindNativeSettingsRead(
          state,
          before.bindingId,
          { bindingId, ...source },
          snapshot,
        );
      });
    });
  }

  async observe(
    ownerId: string,
    value: NativeSettingsObservationRequest,
  ): Promise<NativeSettingsObservationReceipt> {
    const input = nativeSettingsObservationRequestSchema.parse(value);
    const chatId = input.snapshot.context.chatId;
    return this.database.transaction(async (tx) => {
      await lockNativeCommandChat(tx, ownerId, chatId);
      const currentScope = await readScope(tx, ownerId, chatId);
      const [activation] = await tx
        .select()
        .from(schema.nativeCommandActivations)
        .where(eq(schema.nativeCommandActivations.chatId, chatId));
      const next = await changeNativeSettingsState(tx, chatId, (state) => {
        if (
          !state.binding ||
          state.binding.bindingId !== input.bindingId ||
          state.binding.workerId !== input.workerId ||
          input.snapshot.context.workerId !== input.workerId
        )
          throw new NativeCommandError(
            "settings-binding-replaced",
            "The settings observation binding is no longer current.",
          );
        const {
          bindingId: _bindingId,
          runtimeGeneration,
          nativeEpoch: _epoch,
          ...scope
        } = state.binding;
        if (
          !isDeepStrictEqual(scope, currentScope) ||
          (activation?.active &&
            activation.runtimeGeneration &&
            activation.runtimeGeneration !== runtimeGeneration)
        )
          throw new NativeCommandError(
            "settings-binding-replaced",
            "The native settings source has changed.",
          );
        if (
          input.snapshot.context.threadId !== state.binding.threadId ||
          input.snapshot.context.runtimeGeneration !== runtimeGeneration ||
          input.snapshot.context.settingsVersion.epoch !==
            state.binding.nativeEpoch
        )
          throw new NativeCommandError(
            "settings-binding-replaced",
            "A fresh native read is required for this source.",
          );
        if (
          state.effective &&
          state.effective.context.settingsVersion.revision ===
            input.snapshot.context.settingsVersion.revision &&
          state.effective.protectedContent.keyRevision !==
            input.snapshot.protectedContent.keyRevision
        )
          throw new NativeCommandError(
            "settings-binding-replaced",
            "Key rotation requires a fresh native settings read.",
          );
        return observeNativeSettings(state, input.bindingId, input.snapshot);
      });
      return {
        bindingId: input.bindingId,
        revision: next.revision,
        settingsVersion: next.effective!.context.settingsVersion,
      };
    });
  }

  async get(
    ownerId: string,
    chatId: string,
  ): Promise<NativeSettingsState | null> {
    const [row] = await this.database
      .select({ state: schema.nativeSettingsStates.state })
      .from(schema.chats)
      .leftJoin(
        schema.nativeSettingsStates,
        eq(schema.nativeSettingsStates.chatId, schema.chats.id),
      )
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      );
    return row ? parseState(chatId, row.state) : null;
  }
}

/** Caller holds the canonical project/chat lock. The binding is an exact source
 * fence, not a cached runtime-readiness test or a native execution grant. */
export async function assertNativeSettingsWriteBinding(
  tx: RepositoryTransaction,
  ownerId: string,
  chatId: string,
  expectedBindingId: string,
  source?: { workerId: string; session: NativeCommandSession },
): Promise<NativeSettingsBinding> {
  const currentScope = await readScope(tx, ownerId, chatId);
  const state = await new NativeSettingsStateRepository(tx).get(
    ownerId,
    chatId,
  );
  const binding = state?.binding;
  if (!binding || binding.bindingId !== expectedBindingId)
    throw new NativeCommandError(
      "settings-binding-replaced",
      "The selected native settings source is no longer current.",
    );
  const {
    bindingId: _id,
    runtimeGeneration,
    nativeEpoch: _epoch,
    ...scope
  } = binding;
  const [activation] = await tx
    .select()
    .from(schema.nativeCommandActivations)
    .where(eq(schema.nativeCommandActivations.chatId, chatId));
  if (
    !isDeepStrictEqual(scope, currentScope) ||
    (activation?.active &&
      activation.runtimeGeneration &&
      activation.runtimeGeneration !== runtimeGeneration) ||
    (source &&
      (!isDeepStrictEqual(scope, {
        chatId: source.session.chatId,
        workerId: source.workerId,
        threadId: source.session.threadId,
        contextKind: source.session.contextKind,
        projectId: source.session.projectId,
        placementId: source.session.placementId,
        modelRouteId: source.session.modelRouteId,
        providerAccountId: source.session.providerAccountId,
      }) ||
        source.session.runtimeGeneration !== runtimeGeneration))
  )
    throw new NativeCommandError(
      "settings-binding-replaced",
      "The native settings source has changed.",
    );
  return binding;
}

async function readScope(
  tx: RepositoryTransaction,
  ownerId: string,
  chatId: string,
): Promise<NativeSettingsReadScope> {
  const context = await new ChatRuntimeContextRepository(tx, {
    getChatExecutionContext: async () => {
      throw new Error("Unexpected settings context recursion");
    },
  }).getChatExecutionContext(ownerId, chatId);
  if (!context?.threadId)
    throw new NativeCommandError(
      "settings-thread-unbound",
      "The chat has no bound native thread to read.",
    );
  return nativeSettingsReadScopeSchema.parse({
    chatId,
    workerId: context.workerId,
    threadId: context.threadId,
    contextKind: context.contextKind,
    projectId: context.projectId,
    placementId: context.worktreeId ?? context.scratchRootId,
    modelRouteId: context.modelRouteId,
    providerAccountId: context.providerAccountId,
  });
}

function parseState(
  chatId: string,
  value: NativeSettingsState | null,
): NativeSettingsState {
  const state = value
    ? nativeSettingsStateSchema.parse(value)
    : emptyNativeSettingsState(chatId);
  if (state.chatId !== chatId)
    throw new Error("Stored settings belong to another chat.");
  return state;
}

/** Caller holds lockNativeCommandChat. Commit state atomically with command/evidence,
 * never as a second transaction after an input grant has already been issued. */
export async function changeNativeSettingsState(
  tx: RepositoryTransaction,
  chatId: string,
  change: (state: NativeSettingsState) => NativeSettingsState,
): Promise<NativeSettingsState> {
  const [row] = await tx
    .select()
    .from(schema.nativeSettingsStates)
    .where(eq(schema.nativeSettingsStates.chatId, chatId));
  const current = parseState(chatId, row?.state ?? null);
  const next = parseState(chatId, change(current));
  if (next.revision === current.revision) return current;
  await tx
    .insert(schema.nativeSettingsStates)
    .values({ chatId, state: next })
    .onConflictDoUpdate({
      target: schema.nativeSettingsStates.chatId,
      set: { state: next, updatedAt: new Date() },
    });
  return next;
}

function isThreadSettings(command: CommandRow): boolean {
  if (command.method !== "thread/settings/update") return false;
  const intent = nativeCommandIntentSchema.parse(command.intent);
  return intent.scope === "thread" && Boolean(intent.nativeSettingsOperationId);
}

/** Invoke exactly once, after the immutable command journal has deduplicated admission. */
export async function admitNativeSettingsState(
  tx: RepositoryTransaction,
  command: CommandRow,
): Promise<void> {
  if (command.status !== "accepted" || !isThreadSettings(command)) return;
  const source = nativeCommandSessionSchema.parse(command.identity);
  await changeNativeSettingsState(tx, command.chatId, (state) =>
    requestNativeSettings(
      state,
      nativeSettingsIntentSchema.parse({
        operationId: command.operationId,
        operationGeneration: command.operationGeneration,
        origin: command.origin,
        source: {
          workerId: command.workerId,
          threadId: source.threadId,
          runtimeGeneration: source.runtimeGeneration,
        },
        payloadDigest: command.payloadDigest,
        protectedContent: command.protectedPayload,
      }),
    ),
  );
}

export async function settleNativeSettingsState(
  tx: RepositoryTransaction,
  command: CommandRow,
  outcome: "dispatched" | "applied" | "rejected" | "uncertain",
): Promise<void> {
  if (!isThreadSettings(command)) return;
  await changeNativeSettingsState(tx, command.chatId, (state) =>
    settleNativeSettingsIntent(state, command, outcome),
  );
}

/** RPC success acknowledges submission only. Correlated application facts take
 * precedence over transport results; transport loss alone cannot undo application. */
export async function settleNativeSettingsTransport(
  tx: RepositoryTransaction,
  command: CommandRow,
): Promise<void> {
  if (!isThreadSettings(command)) return;
  const application = command.settingsApplication?.status;
  const outcome =
    application && application !== "pending"
      ? application
      : command.status === "rejected" || command.status === "uncertain"
        ? command.status
        : null;
  if (outcome) await settleNativeSettingsState(tx, command, outcome);
}
