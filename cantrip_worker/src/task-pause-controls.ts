import { isDeepStrictEqual } from "node:util";
import type { ChatPauseRuntimeState, TaskPauseIntent } from "@cantrip/protocol";
import type { CodexAppServer } from "./codex/app-server.js";

interface Control {
  intent: TaskPauseIntent;
  runtimes: {
    runtime: CodexAppServer;
    generation: string | null;
    target: string;
  }[];
  applied: Promise<void>;
  settled: Promise<ChatPauseRuntimeState>;
  failed?: boolean;
  interruption?: Promise<{ interrupted: boolean }>;
}

/** One retained control per live Task, scoped to this worker's server owner.
 * This is control ordering, not an inference queue or a provider semaphore. */
export class TaskPauseControls {
  readonly #controls = new Map<string, Control>();
  constructor(
    private readonly options: {
      scope: () => { serverId: string; ownerId: string; workerId: string };
      runtimes: () => Iterable<CodexAppServer>;
      selected: (chatId: string) => CodexAppServer | undefined;
      setPaused: (chatId: string, paused: boolean) => void;
      onError: (error: unknown) => void;
    },
  ) {}

  private key(chat: string) {
    return JSON.stringify([this.options.scope(), chat]);
  }

  forget(chat: string) {
    this.#controls.delete(this.key(chat));
  }

  async prepared(chat: string) {
    const control = this.#controls.get(this.key(chat));
    if (control) await this.request(chat, control.intent).applied;
  }

  seedRuntime(chat: string, runtime: CodexAppServer) {
    const control = this.#controls.get(this.key(chat));
    if (control) runtime.setTaskChatPaused(chat, control.intent.paused);
  }

  /** A raw Task Stop first closes future admission through the existing durable
   * pause intent, then interrupts actual native turns. It grants no capacity. */
  async interrupt(chat: string, intent: TaskPauseIntent) {
    if (!intent.paused)
      throw new Error("Task interruption requires paused intent.");
    const key = this.key(chat);
    const namespace = this.options.scope();
    const control = this.request(chat, intent);
    const current = () =>
      this.#controls.get(key) === control &&
      control.intent.paused &&
      control.intent.scope.revision === intent.scope.revision &&
      isDeepStrictEqual(this.options.scope(), namespace);
    await control.applied;
    if (!current()) return { interrupted: false };
    return (control.interruption ??= (async () => {
      // Stop cleans up actual owners even after canonical model/account routing
      // disappeared. Pause/Resume keeps its narrower current-source selection.
      const results = await Promise.all(
        [...this.options.runtimes()].map((runtime) =>
          runtime.interruptTaskChat(chat, intent.scope, current),
        ),
      );
      return { interrupted: results.some((result) => result.interrupted) };
    })().catch((error) => {
      delete control.interruption;
      if (!current()) return { interrupted: false };
      throw error;
    }));
  }

  request(chat: string, intent: TaskPauseIntent) {
    const namespace = this.options.scope();
    if (intent.scope.workerId !== namespace.workerId)
      throw new Error("The Task pause belongs to another worker.");
    const key = this.key(chat);
    const prior = this.#controls.get(key);
    if (prior && prior.intent.scope.revision > intent.scope.revision)
      return prior;
    if (
      prior?.intent.scope.revision === intent.scope.revision &&
      (prior.intent.scope.orderEpoch ?? -1) > (intent.scope.orderEpoch ?? -1)
    )
      return prior;
    if (
      prior?.intent.scope.revision === intent.scope.revision &&
      prior.intent.paused !== intent.paused
    )
      throw new Error("The Task pause revision changed its intent.");
    const available = [...this.options.runtimes()];
    for (const runtime of available)
      runtime.adoptTaskGoalOrder(chat, intent.scope);
    const selected = this.options.selected(chat);
    // A published transfer owns the current root. If that publication refers
    // to an older Task continuation, match the actual canonical thread instead.
    const candidates =
      selected &&
      available.includes(selected) &&
      selected.matchesTaskPauseScope(chat, intent.scope)
        ? [selected]
        : available;
    const runtimes = candidates
      .filter((runtime) => runtime.matchesTaskPauseScope(chat, intent.scope))
      .map((runtime) => ({
        runtime,
        generation: runtime.transportGeneration,
        target: runtime.taskPauseTargetKey(chat, intent.scope),
      }));
    if (
      prior &&
      !prior.failed &&
      isDeepStrictEqual(prior.intent, intent) &&
      prior.runtimes.length === runtimes.length &&
      prior.runtimes.every(
        (value, index) =>
          value.runtime === runtimes[index]?.runtime &&
          value.generation === runtimes[index]?.generation &&
          value.target === runtimes[index]?.target,
      )
    )
      return prior;
    let apply!: () => void;
    let rejectApply!: (error: unknown) => void;
    const control: Control = {
      intent: structuredClone(intent),
      runtimes,
      applied: new Promise<void>((resolve, reject) => {
        apply = resolve;
        rejectApply = reject;
      }),
      settled: undefined as never,
    };
    // Install the high-water mark before any native RPC or async history read.
    this.#controls.set(key, control);
    const current = () =>
      this.#controls.get(key) === control &&
      isDeepStrictEqual(this.options.scope(), namespace);
    this.options.setPaused(chat, intent.paused);
    for (const runtime of this.options.runtimes())
      runtime.setTaskChatPaused(chat, intent.paused);
    control.settled = (async () => {
      let applied = 0;
      if (!runtimes.length) apply(); // A not-yet-prepared root inherits the latch.
      const active = await Promise.all(
        runtimes.map(({ runtime }) =>
          runtime.setTaskPauseIntent(
            chat,
            intent.paused,
            intent.scope,
            current,
            () => {
              if (++applied === runtimes.length) apply();
            },
          ),
        ),
      );
      if (!current()) {
        const newer = this.#controls.get(key);
        if (newer) return newer.settled;
        throw new Error("The Task control owner was revoked.");
      }
      return {
        paused: intent.paused,
        active: active.find((value) => value !== null) ?? null,
      };
    })().catch((error) => {
      rejectApply(error);
      const newer = this.#controls.get(key);
      if (newer && newer !== control) return newer.settled;
      // Never undo an intent on an ambiguous/failed native response. The server
      // may compensate with a higher revision; a real retry can reconcile it.
      if (current()) control.failed = true;
      throw error;
    });
    void control.applied.catch(() => {});
    void control.settled.catch((error) => this.options.onError(error));
    return control;
  }
}
