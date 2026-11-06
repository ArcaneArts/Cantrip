import { randomUUID } from "node:crypto";
import {
  nativeSuspensionActiveTurnSchema,
  nativeSuspensionActorSchema,
  nativeSuspensionErrorSchema,
  nativeSuspensionEvidenceSchema,
  nativeSuspensionRecordSchema,
  isNativeSuspensionResumable,
  type NativeSuspensionActiveTurn,
  type NativeSuspensionActor,
  type NativeSuspensionError,
  type NativeSuspensionEvidence,
  type NativeSuspensionRecord,
} from "@cantrip/protocol";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryDatabase, RepositoryTransaction } from "./database.js";
import { nativeCommandContext } from "./native-command-context.js";
import { NativeCommandError } from "./native-command-errors.js";
import { lockNativeCommandChat } from "./native-command-lock.js";
import type { ChatExecutionContext } from "./chat-execution-lanes.js";

type Chat = typeof schema.chats.$inferSelect;
type State = NativeSuspensionRecord;
type Change = { state: State; changed: boolean };
/** No checkpoint means a surviving-owner attempt only, never cold restoration. */
export function isLiveNativeSuspensionResume(
  state: State | null | undefined,
): state is State {
  return (
    !!state &&
    state.checkpoint === null &&
    state.active !== null &&
    state.action !== "stop" &&
    (state.phase === "error" ||
      (state.action === "resume" &&
        ["resuming", "running"].includes(state.phase)))
  );
}
const terminal = new Set<State["phase"]>([
  "stopped",
  "completed",
  "failed",
  "idle",
]);
export function sameNativeSuspensionSource(
  context: ChatExecutionContext | null,
  chat: Chat,
  state: State,
): boolean {
  const target = state.target;
  return (
    !!context &&
    target.workerId === context.workerId &&
    target.contextKind === context.contextKind &&
    target.projectId === context.projectId &&
    target.placementId === (context.worktreeId ?? context.scratchRootId) &&
    target.placementRevision === chat.placementRevision &&
    target.cantripOsBindingId === chat.cantripOsBindingId &&
    target.threadId === context.threadId &&
    target.modelRouteId === context.modelRouteId &&
    target.providerAccountId === context.providerAccountId
  );
}
const sameActor = (a: State["actor"], b: State["actor"]) =>
  a === null || b === null
    ? a === b
    : a.workerGeneration === b.workerGeneration &&
      a.runtimeGeneration === b.runtimeGeneration &&
      a.operationId === b.operationId &&
      a.operationGeneration === b.operationGeneration;
const sameTurn = (a: State["active"], b: State["active"]) =>
  a === null || b === null
    ? a === b
    : a.threadId === b.threadId && a.turnId === b.turnId;
function conflict(code: string): never {
  throw new NativeCommandError(code, code, 409);
}
function decode(raw: unknown): State | null {
  if (raw === null) return null;
  const result = nativeSuspensionRecordSchema.safeParse(raw);
  if (!result.success) conflict("suspension-state-unreadable");
  return result.data;
}
function finishPausedTime(state: State, now: Date): State {
  return {
    ...state,
    pausedAt: null,
    pausedMilliseconds: Math.min(
      Number.MAX_SAFE_INTEGER,
      state.pausedMilliseconds +
        (state.pausedAt === null
          ? 0
          : Math.max(0, now.getTime() - Date.parse(state.pausedAt))),
    ),
  };
}

/** Durable control records, not admission grants. Callers must authenticate and admit
 * actual worker/runtime operations separately before claiming their correlation IDs. */
export class NativeSuspensionRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly transaction?: RepositoryTransaction,
  ) {}

  inTransaction(tx: RepositoryTransaction): NativeSuspensionRepository {
    return new NativeSuspensionRepository(this.database, tx);
  }

  async read(ownerId: string, chatId: string): Promise<State | null> {
    const [row] = await (this.transaction ?? this.database)
      .select({ state: schema.chats.nativeSuspensionState })
      .from(schema.chats)
      .where(
        and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
      );
    if (!row)
      throw new NativeCommandError("chat-not-found", "Chat not found.", 404);
    return decode(row.state);
  }

  private async change(
    ownerId: string,
    chatId: string,
    apply: (
      tx: RepositoryTransaction,
      chat: Chat,
      current: State | null,
      now: Date,
    ) => Promise<Change>,
  ): Promise<Change> {
    const applyChange = async (tx: RepositoryTransaction) => {
      await lockNativeCommandChat(tx, ownerId, chatId);
      const [chat] = await tx
        .select()
        .from(schema.chats)
        .where(
          and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
        );
      if (!chat)
        throw new NativeCommandError("chat-not-found", "Chat not found.", 404);
      const now = new Date();
      const change = await apply(
        tx,
        chat,
        decode(chat.nativeSuspensionState),
        now,
      );
      if (!change.changed) return change;
      const state = nativeSuspensionRecordSchema.parse({
        ...change.state,
        updatedAt: now.toISOString(),
      });
      await tx
        .update(schema.chats)
        .set({
          nativeSuspensionState: state,
          // Only an acknowledged Resume releases the hold. Terminal events retain
          // the user's queue intent; a Stop also retains the autonomy fence.
          automationPaused:
            state.phase === "running"
              ? false
              : ["completed", "failed"].includes(state.phase)
                ? chat.automationPaused
                : true,
          ...(state.action === "stop" ? { managedAutonomyStopped: true } : {}),
          updatedAt: now,
        })
        .where(
          and(eq(schema.chats.id, chatId), eq(schema.chats.ownerId, ownerId)),
        );
      await tx
        .update(schema.managedQueueStates)
        .set({ revision: sql`${schema.managedQueueStates.revision} + 1` })
        .where(eq(schema.managedQueueStates.chatId, chatId));
      return { state, changed: true };
    };
    return this.transaction
      ? applyChange(this.transaction)
      : this.database.transaction(applyChange);
  }

  /** Commit intent before IPC. Duplicates join the canonical in-flight control. */
  async request(
    ownerId: string,
    chatId: string,
    action: State["action"],
    expectedActive?: NativeSuspensionActiveTurn,
  ): Promise<Change> {
    if (expectedActive)
      expectedActive = nativeSuspensionActiveTurnSchema.parse(expectedActive);
    return this.change(ownerId, chatId, async (tx, chat, current, now) => {
      if (
        current &&
        ((action === "pause" &&
          ["pausing", "paused"].includes(current.phase)) ||
          (action === "resume" && current.phase === "resuming") ||
          (action === "stop" &&
            ["stopping", "stopped", "completed", "failed", "idle"].includes(
              current.phase,
            ) &&
            (current.phase === "stopping" ||
              !expectedActive ||
              sameTurn(current.active, expectedActive))))
      )
        return { state: current, changed: false };
      if (
        current?.action === "stop" &&
        !terminal.has(current.phase) &&
        action !== "stop"
      )
        conflict("suspension-stop-pending");
      if (
        action === "resume" &&
        (!current ||
          (!isNativeSuspensionResumable(current) &&
            !(
              current.phase === "error" && isLiveNativeSuspensionResume(current)
            )))
      )
        conflict("suspension-not-resumable");

      if (action === "stop" && current && !terminal.has(current.phase))
        return {
          state: {
            ...current,
            controlId: randomUUID(),
            actorControlId: null,
            action,
            phase: "stopping",
            error: null,
            requestedAt: now.toISOString(),
          },
          changed: true,
        };

      const context = await nativeCommandContext(tx, ownerId, chatId);
      if (!context) conflict("suspension-source-unavailable");
      let source = current && !terminal.has(current.phase) ? current : null;
      if (source && !sameNativeSuspensionSource(context, chat, source))
        conflict("suspension-authority-changed");
      if (!source) {
        const [activation] = await tx
          .select({ operationId: schema.nativeCommandActivations.operationId })
          .from(schema.nativeCommandActivations)
          .where(eq(schema.nativeCommandActivations.chatId, chatId));
        source = {
          version: 1,
          controlId: randomUUID(),
          action,
          phase: "pausing",
          target: {
            workerId: context.workerId,
            contextKind: context.contextKind,
            projectId: context.projectId,
            placementId: context.worktreeId ?? context.scratchRootId,
            placementRevision: chat.placementRevision,
            cantripOsBindingId: chat.cantripOsBindingId,
            executionLaneId: context.executionLaneId,
            modelRouteId: context.modelRouteId,
            providerAccountId: context.providerAccountId,
            threadId: context.threadId,
            originalOperationId: activation?.operationId ?? null,
          },
          active: null,
          checkpoint: null,
          actor: null,
          actorControlId: null,
          error: null,
          requestedAt: now.toISOString(),
          updatedAt: now.toISOString(),
          pausedAt: null,
          pausedMilliseconds: 0,
        };
      }
      return {
        state: {
          ...source,
          controlId: randomUUID(),
          actorControlId: null,
          action,
          phase:
            action === "pause"
              ? "pausing"
              : action === "resume"
                ? "resuming"
                : "stopping",
          error: null,
          requestedAt: now.toISOString(),
        },
        changed: true,
      };
    });
  }

  /** Fresh execution identity replaces the old actor only with an exact CAS. */
  async claim(
    ownerId: string,
    chatId: string,
    controlId: string,
    expectedActor: State["actor"],
    actor: NativeSuspensionActor,
    active: NativeSuspensionActiveTurn | null,
    executionOwner?: NativeSuspensionActor,
  ): Promise<Change> {
    expectedActor = nativeSuspensionActorSchema.nullable().parse(expectedActor);
    actor = nativeSuspensionActorSchema.parse(actor);
    active = nativeSuspensionActiveTurnSchema.nullable().parse(active);
    if (executionOwner)
      executionOwner = nativeSuspensionActorSchema.parse(executionOwner);
    return this.change(ownerId, chatId, async (tx, chat, current) => {
      const state = this.current(current, controlId);
      if (
        state.phase === "resuming" &&
        !state.checkpoint &&
        (state.actor?.workerGeneration !== actor.workerGeneration ||
          state.actor?.runtimeGeneration !== actor.runtimeGeneration)
      )
        conflict("suspension-live-owner-unavailable");
      if (
        executionOwner &&
        (!["resuming", "stopping"].includes(state.phase) ||
          !state.checkpoint ||
          !sameActor(actor, executionOwner))
      )
        conflict("invalid-suspension-execution-owner");
      if (
        state.phase !== "stopping" &&
        !sameNativeSuspensionSource(
          await nativeCommandContext(tx, ownerId, chatId),
          chat,
          state,
        )
      )
        conflict("suspension-authority-changed");
      if (!["pausing", "resuming", "stopping"].includes(state.phase))
        conflict("suspension-control-settled");
      if (
        sameActor(state.actor, actor) &&
        sameTurn(state.active, active) &&
        state.actorControlId === controlId &&
        (!executionOwner ||
          sameActor(state.executionOwner ?? null, executionOwner))
      )
        return { state, changed: false };
      if (!sameActor(state.actor, expectedActor))
        conflict("suspension-actor-stale");
      if (
        (state.active && !sameTurn(state.active, active)) ||
        (active && active.threadId !== state.target.threadId) ||
        (state.phase === "resuming" && !active)
      )
        conflict("suspension-turn-mismatch");
      return {
        state: {
          ...state,
          actor,
          active,
          actorControlId: controlId,
          ...(executionOwner ? { executionOwner } : {}),
        },
        changed: true,
      };
    });
  }

  private current(current: State | null, controlId: string): State {
    if (!current || current.controlId !== controlId)
      conflict("suspension-control-stale");
    return current;
  }

  private acknowledge(
    ownerId: string,
    chatId: string,
    controlId: string,
    actor: State["actor"],
    apply: (state: State, now: Date) => Change,
  ): Promise<Change> {
    actor = nativeSuspensionActorSchema.nullable().parse(actor);
    return this.change(ownerId, chatId, async (tx, chat, current, now) => {
      const state = this.current(current, controlId);
      if (!sameActor(state.actor, actor)) conflict("suspension-actor-stale");
      const next = apply(state, now);
      if (
        ["paused", "running", "stopped", "idle"].includes(next.state.phase) &&
        state.actorControlId !== controlId
      )
        conflict("suspension-actor-unclaimed");
      if (
        ["paused", "running"].includes(next.state.phase) &&
        !sameNativeSuspensionSource(
          await nativeCommandContext(tx, ownerId, chatId),
          chat,
          state,
        )
      )
        conflict("suspension-authority-changed");
      return next;
    });
  }

  async paused(
    ownerId: string,
    chatId: string,
    controlId: string,
    actor: NativeSuspensionActor,
    checkpoint: NativeSuspensionEvidence,
  ): Promise<Change> {
    checkpoint = nativeSuspensionEvidenceSchema.parse(checkpoint);
    return this.acknowledge(ownerId, chatId, controlId, actor, (state, now) => {
      if (
        state.phase === "paused" &&
        JSON.stringify(state.checkpoint) === JSON.stringify(checkpoint)
      )
        return { state, changed: false };
      if (state.phase !== "pausing") conflict("suspension-control-settled");
      if (
        state.active?.threadId !== checkpoint.suspension.threadId ||
        state.active.turnId !== checkpoint.suspension.turnId
      )
        conflict("suspension-turn-mismatch");
      return {
        state: {
          ...state,
          phase: "paused",
          checkpoint,
          pausedAt: state.pausedAt ?? now.toISOString(),
        },
        changed: true,
      };
    });
  }

  async running(
    ownerId: string,
    chatId: string,
    controlId: string,
    actor: NativeSuspensionActor,
  ): Promise<Change> {
    return this.acknowledge(ownerId, chatId, controlId, actor, (state, now) => {
      if (state.phase === "running") return { state, changed: false };
      if (state.phase !== "resuming" || !state.active)
        conflict("suspension-control-settled");
      return {
        state: { ...finishPausedTime(state, now), phase: "running" },
        changed: true,
      };
    });
  }

  async idle(
    ownerId: string,
    chatId: string,
    controlId: string,
    actor: NativeSuspensionActor,
  ): Promise<Change> {
    return this.acknowledge(ownerId, chatId, controlId, actor, (state, now) => {
      if (state.phase !== "pausing" || state.active)
        conflict("suspension-control-settled");
      return {
        state: {
          ...finishPausedTime(state, now),
          phase: "idle",
          checkpoint: null,
        },
        changed: true,
      };
    });
  }

  async failedControl(
    ownerId: string,
    chatId: string,
    controlId: string,
    actor: State["actor"],
    error: NativeSuspensionError,
  ): Promise<Change> {
    error = nativeSuspensionErrorSchema.parse(error);
    return this.acknowledge(ownerId, chatId, controlId, actor, (state) => {
      if (
        terminal.has(state.phase) ||
        ["paused", "running"].includes(state.phase)
      )
        conflict("suspension-control-settled");
      return { state: { ...state, phase: "error", error }, changed: true };
    });
  }

  async stopped(
    ownerId: string,
    chatId: string,
    controlId: string,
    actor: NativeSuspensionActor,
  ): Promise<Change> {
    return this.acknowledge(ownerId, chatId, controlId, actor, (state, now) => {
      if (state.phase === "stopped") return { state, changed: false };
      if (state.phase !== "stopping") conflict("suspension-control-settled");
      return {
        state: {
          ...finishPausedTime(state, now),
          phase: "stopped",
          checkpoint: null,
          error: null,
        },
        changed: true,
      };
    });
  }

  /** Terminal proof is fenced by both control and execution owner, not turn IDs alone. */
  async finished(
    ownerId: string,
    chatId: string,
    controlId: string,
    actor: NativeSuspensionActor,
    active: NativeSuspensionActiveTurn,
    outcome: "completed" | "failed",
  ): Promise<Change> {
    active = nativeSuspensionActiveTurnSchema.parse(active);
    return this.acknowledge(ownerId, chatId, controlId, actor, (state, now) => {
      if (!sameTurn(state.active, active)) conflict("suspension-turn-mismatch");
      if (state.phase === outcome) return { state, changed: false };
      if (terminal.has(state.phase)) conflict("suspension-control-settled");
      return {
        state: {
          ...finishPausedTime(state, now),
          phase: outcome,
          checkpoint: null,
          error: null,
        },
        changed: true,
      };
    });
  }
}
