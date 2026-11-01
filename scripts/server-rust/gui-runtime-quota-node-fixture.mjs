import { createModelRoutingRuntime } from "../../cantrip_server/src/app/runtime/model-routing-runtime.ts";

// Only the unchanged routing service's timers use this controlled clock. Database
// and transport timers continue to run normally while real SQL is awaited.
export async function runtimeQuotaFixture(repository, input) {
  const original = {
    now: Date.now,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  let now = input.now,
    response = input.snapshot;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const timers = new Map(),
    pending = new Set(),
    commands = [],
    publications = [],
    logs = [];
  const track = (promise) => {
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  const settle = async () => {
    for (;;) {
      await Promise.allSettled([...pending]);
      await new Promise(setImmediate);
      if (pending.size === 0) return;
    }
  };
  const trackedRepository = new Proxy(repository, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (
        [
          "recordModelProviderAccountCredits",
          "recordProviderQuotaObservation",
        ].includes(key)
      )
        return (...args) => track(value.apply(target, args));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  Date.now = () => now;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (
      !new Error().stack
        .split("\n")[2]
        ?.includes("app/runtime/model-routing-runtime.ts")
    )
      return original.setTimeout(callback, delay, ...args);
    const timer = {
      quotaFixtureTimer: true,
      unref() {
        return this;
      },
    };
    timers.set(timer, {
      at: now + Math.max(1, Math.trunc(delay)),
      callback: () => callback(...args),
    });
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer?.quotaFixtureTimer) timers.delete(timer);
    else original.clearTimeout(timer);
  };
  const log = (level) => (context, message) => {
    const record = { level, message, error: Boolean(context.err) };
    for (const key of [
      "accountId",
      "providerId",
      "providerAccountId",
      "trigger",
      "workerId",
    ])
      if (key in context) record[key] = context[key];
    logs.push(record);
  };
  const runtime = structuredClone(input.runtime);
  const routing = createModelRoutingRuntime({
    repository: trackedRepository,
    applicationOwnerId: () => input.owner,
    app: { log: { warn: log("warn"), debug: log("debug") } },
    bridge: {
      request(worker, command, options) {
        return track(
          (async () => {
            commands.push({
              ownerId: options.ownerId,
              worker,
              command,
              atMs: now,
              timeoutMs: options.timeoutMs,
            });
            if (input.closeWhilePending) await blocked;
            if (input.requestFailure)
              throw new Error("Controlled quota failure");
            return response;
          })(),
        );
      },
    },
    publishLiveInvalidation: (resource) =>
      publications.push({ ownerId: input.owner, resource }),
  });
  try {
    if (input.closeWhilePending) {
      routing.scheduleRuntimeQuotaSamples(
        runtime,
        input.execution,
        input.attempt,
        input.turnId ?? null,
      );
      routing.close();
      release();
      await settle();
    }
    for (const step of input.steps) {
      if ("snapshot" in step) response = step.snapshot;
      if (step.op === "capture")
        routing.captureRuntimeQuota(
          runtime,
          input.execution,
          step.trigger ?? "fixture-capture",
          input.attempt,
          input.turnId ?? null,
        );
      else if (step.op === "completed")
        routing.scheduleRuntimeQuotaSamples(
          runtime,
          input.execution,
          input.attempt,
          input.turnId ?? null,
        );
      else if (step.op === "activity")
        await routing.recordRuntimeRateLimitActivity(
          runtime,
          input.execution,
          input.attempt,
          step.activity,
        );
      else if (step.op === "advance") {
        const target = now + step.byMs;
        for (;;) {
          const next = [...timers.entries()]
            .filter(([, timer]) => timer.at <= target)
            .sort((a, b) => a[1].at - b[1].at)[0];
          if (!next) break;
          const [key, timer] = next;
          timers.delete(key);
          now = timer.at;
          timer.callback();
          await settle();
        }
        now = target;
      } else if (step.op === "close") routing.close();
      else throw new Error("Unknown quota fixture step");
      await settle();
    }
    return {
      runtime,
      publications,
      logs,
      commands,
      remainingTimers: [...timers.values()]
        .map((t) => t.at)
        .sort((a, b) => a - b),
    };
  } finally {
    routing.close();
    Date.now = original.now;
    globalThis.setTimeout = original.setTimeout;
    globalThis.clearTimeout = original.clearTimeout;
  }
}
