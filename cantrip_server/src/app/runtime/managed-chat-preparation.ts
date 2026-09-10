import { randomUUID } from "node:crypto";
import {
  encryptedLinkedConsoleCreateSchema,
  type ManagedChatPreparation,
} from "@cantrip/protocol";
import type {
  ServerRepository,
  ChatExecutionContext,
} from "../../db/repository.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import type { createModelRoutingRuntime } from "./model-routing-runtime.js";
import { prepareManagedConsoleLaunch } from "../../terminals/managed-session.js";
import { boundManagedRuntime } from "../../terminals/bound-managed-runtime.js";

type Dependencies = Pick<
  ReturnType<typeof createModelRoutingRuntime>,
  "runtimeForContext" | "routePairsForConfiguration"
> & {
  repository: ServerRepository;
  bridge: Pick<WorkerCommandBus, "request">;
  serverId: string;
  publish(ownerId: string, chatId: string): void;
  runAsOwner<T>(ownerId: string, run: () => Promise<T>): Promise<T>;
};
const eligible = (
  context: ChatExecutionContext | null,
): context is ChatExecutionContext =>
  Boolean(
    context &&
    context.contextKind === "project" &&
    context.experience === "agent",
  );

/** Session lifetime belongs to the worker, not a mounted terminal presentation.
 * GUI input joins only thread preparation; a CLI launch failure cannot disable
 * an otherwise prepared native conversation. No model input is synthesized. */
export function createManagedChatPreparation(deps: Dependencies) {
  const jobs = deps.repository.managedChatPreparations;
  const active = new Map<
    string,
    { nativeReady: Promise<void>; finished: Promise<void> }
  >();
  const key = (ownerId: string, chatId: string) => `${ownerId}:${chatId}`;
  const start = (
    ownerId: string,
    chatId: string,
    replace = false,
    recovery?: Promise<void>,
  ) => {
    const identity = key(ownerId, chatId);
    const existing = active.get(identity);
    if (existing && !replace) return existing;
    let nativeReady!: () => void;
    let nativeFailed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      nativeReady = resolve;
      nativeFailed = reject;
    });
    void ready.catch(() => {});
    const job = { nativeReady: ready, finished: Promise.resolve() };
    active.set(identity, job);
    job.finished = deps.runAsOwner(ownerId, async () => {
      let state: ManagedChatPreparation | null = null;
      let phase: "thread" | "console" = "thread";
      try {
        // Resolve placement only after this chat's in-flight transfer settles.
        // Register the job first so an immediate GUI join waits with it.
        await recovery;
        if (active.get(identity) !== job)
          throw new Error("The preparation was replaced.");
        const context = await deps.repository.getChatExecutionContext(
          ownerId,
          chatId,
        );
        if (!eligible(context)) {
          nativeReady();
          return;
        }
        state = await jobs.claim(ownerId, chatId, context.workerId);
        if (!state) {
          nativeReady();
          return;
        }
        deps.publish(ownerId, chatId);
        const runtime =
          context.threadId && context.modelRouteId
            ? await boundManagedRuntime(ownerId, context, deps.repository)
            : await deps.runtimeForContext(context);
        if (!runtime)
          throw new Error("No configured provider route is available.");
        const launch = await prepareManagedConsoleLaunch(context, runtime, {
          ...deps,
          ownerId,
        });
        if (
          context.threadId &&
          (launch.model.routeId !== context.modelRouteId ||
            (launch.provider.accountId ?? null) !== context.providerAccountId)
        )
          throw new Error("The bound provider identity changed.");
        if (context.threadId) {
          const { type: _type, ...configuration } = launch;
          const existing = (await deps.bridge.request(
            context.workerId,
            {
              type: "chat.thread.ensure",
              cwd: context.cwd,
              ...configuration,
              planMode: configuration.planMode ?? context.planMode,
              permissionProfileId:
                configuration.permissionProfileId ?? ":workspace",
              mcpServers: configuration.mcpServers ?? [],
            },
            { ownerId, timeoutMs: null },
          )) as { threadId: string };
          if (existing.threadId !== launch.threadId)
            throw new Error("The prepared native thread changed.");
        }
        const current = await deps.repository.getChatExecutionContext(
          ownerId,
          chatId,
        );
        if (
          !eligible(current) ||
          current.workerId !== context.workerId ||
          current.worktreeId !== context.worktreeId ||
          current.threadId !== launch.threadId
        )
          throw new Error("The prepared chat placement changed.");
        phase = "console";
        const updated = await jobs.update(ownerId, state, "console");
        if (!updated) throw new Error("The preparation was replaced.");
        state = updated;
        nativeReady();
        deps.publish(ownerId, chatId);
        const protectedState = encryptedLinkedConsoleCreateSchema.parse(
          await deps.bridge.request(
            context.workerId,
            {
              type: "terminal.prepare-state",
              terminalId: state.terminalId,
              serverId: deps.serverId,
            },
            { ownerId, timeoutMs: null },
          ),
        );
        if (protectedState.id !== state.terminalId)
          throw new Error("Console identity changed.");
        const terminal = await deps.repository.getOrCreateChatConsole(
          ownerId,
          chatId,
          protectedState,
        );
        if (!terminal?.stateProtection)
          throw new Error("The chat console is unavailable.");
        const attachmentId = `managed-preparation:${state.generation}`;
        let markReady!: () => void;
        let markFailed!: (error: unknown) => void;
        const spawned = new Promise<void>((resolve, reject) => {
          markReady = resolve;
          markFailed = reject;
        });
        const opened = deps.bridge.request(
          context.workerId,
          {
            type: "terminal.open",
            terminalId: terminal.id,
            attachmentId,
            operationId: randomUUID(),
            serverId: deps.serverId,
            worktreePath: current.cwd,
            stateProtection: terminal.stateProtection,
            cols: 100,
            rows: 30,
            outputMode: "discard",
            launch,
          },
          {
            ownerId,
            timeoutMs: null,
            onEvent: (event) => {
              if (event.type === "terminal.ready") markReady();
            },
          },
        );
        void opened.then(
          () =>
            markFailed(
              new Error("The CLI exited before preparation completed."),
            ),
          markFailed,
        );
        try {
          await spawned;
        } finally {
          await deps.bridge.request(
            context.workerId,
            { type: "terminal.detach", terminalId: terminal.id, attachmentId },
            { ownerId, timeoutMs: null },
          );
        }
        await opened;
        await jobs.update(ownerId, state, "ready", null, terminal.id);
      } catch (error) {
        nativeFailed(error);
        if (state) await jobs.update(ownerId, state, "failed", phase);
      } finally {
        if (active.get(identity) === job) active.delete(identity);
        deps.publish(ownerId, chatId);
      }
    });
    void job.finished.catch(() => {});
    return job;
  };
  return {
    async request(ownerId: string, chatId: string) {
      if (active.has(key(ownerId, chatId))) return jobs.get(ownerId, chatId);
      const context = await deps.repository.getChatExecutionContext(
        ownerId,
        chatId,
      );
      if (!eligible(context)) return null;
      const state = await jobs.request(ownerId, chatId, context.workerId);
      start(ownerId, chatId);
      return state;
    },
    async join(ownerId: string, chatId: string) {
      const existing = active.get(key(ownerId, chatId));
      if (existing) return existing.nativeReady;
      const state = await jobs.get(ownerId, chatId);
      if (state && state.phase !== "ready" && state.failedPhase !== "console")
        await start(ownerId, chatId).nativeReady;
    },
    async workerConnected(
      ownerId: string,
      workerId: string,
      recoveries: ReadonlyMap<string, Promise<void>> = new Map(),
    ) {
      for (const chatId of await jobs.forWorker(ownerId, workerId))
        start(ownerId, chatId, true, recoveries.get(chatId));
    },
    async settle(ownerId: string, chatId: string) {
      await active.get(key(ownerId, chatId))?.finished;
    },
  };
}
