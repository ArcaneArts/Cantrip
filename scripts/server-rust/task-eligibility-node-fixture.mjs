// The production eligibility cache and real routing/repositories. Catalog I/O
// and connection state are explicitly controlled fixture boundaries.
import { createTaskDispatchEligibilityRuntime } from "../../cantrip_server/src/app/runtime/task-dispatch-eligibility-runtime.ts";
import { createModelRoutingRuntime } from "../../cantrip_server/src/app/runtime/model-routing-runtime.ts";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const { sql } = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("drizzle-orm");
export async function taskEligibilityFixture(repository, input) {
  const pending = new Set(),
    logs = [],
    hydration = { started: 0, finished: 0 };
  const track = (promise) => {
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  const execute = (statement) =>
    repository.nativeCommands.database.execute(sql.raw(statement));
  const log = (fields, message) => {
    if (!fields.event?.startsWith("task.scheduler.")) return;
    const { err, ...rest } = fields;
    logs.push({
      ...rest,
      message,
      level: "warn",
      error: Boolean(err),
      errorMessage: err?.message,
      errorClass: err?.name,
    });
  };
  const app = { log: { info: log, warn: log, error: log } };
  let connectionChecks = 0;
  const bridge = {
    isConnected: (worker) =>
      (input.disconnectAfterChecks === undefined ||
        connectionChecks++ < input.disconnectAfterChecks) &&
      input.connected !== false &&
      !(input.disconnectedWorkers ?? []).includes(worker),
  };
  const routing = createModelRoutingRuntime({
    repository,
    bridge,
    app,
    applicationOwnerId: () => input.owner,
    routeCooldowns: new Map(input.cooldowns ?? []),
    runtimeCooldownKey: (r) =>
      ["chatgpt", "grok"].includes(r.provider.kind) && r.provider.accountId
        ? `${r.routeId}:account:${r.provider.accountId}`
        : r.routeId,
    publishLiveInvalidation() {
      throw new Error("Unexpected eligibility publication");
    },
    publishProjectTokenUsageChange() {
      throw new Error("Unexpected eligibility usage publication");
    },
    openRouterRuntimeCatalogs: {
      hydrate: async () => {
        hydration.started++;
        try {
          if (input.hydrateDelayMs) await delay(input.hydrateDelayMs);
          if (input.hydrateSql) await execute(input.hydrateSql);
          if (input.failHydrate)
            throw new Error("Controlled eligibility catalog failure");
          return input.catalogChanged === true;
        } finally {
          hydration.finished++;
        }
      },
    },
  });
  const service = createTaskDispatchEligibilityRuntime(
    {
      repository,
      bridge,
      ...routing,
      routePairsForConfiguration: (...args) =>
        track(routing.routePairsForConfiguration(...args)),
      availableModelRuntimes: (...args) =>
        track(routing.availableModelRuntimes(...args)),
    },
    app,
    input.timeoutMs,
  );
  try {
    const resume =
      input.action === "resume" || input.action === "prepare-resume";
    const prepared = resume
      ? await service.prepareTaskResumeEligibility(input.owner)
      : await service.prepareTaskDispatchEligibility(input.owner);
    if (input.afterPrepareSql) await execute(input.afterPrepareSql);
    const cycles = await repository.taskDispatch.list(input.owner),
      workers = await repository.taskScheduling.listTaskWorkers(input.owner);
    const resolutions = [];
    if (resume) {
      for (const cycle of cycles)
        resolutions.push({
          cycleId: cycle.id,
          resolution: await prepared({ ...cycle, ...input.resumeProbeChanges }),
        });
    } else {
      for (const cycle of cycles) {
        const context = await repository.getChatExecutionContext(
          input.owner,
          cycle.chatId,
        );
        for (const taskWorker of workers) {
          const probe = {
            cycle,
            taskWorker,
            projectId: context?.projectId ?? null,
            physicalWorkerId: context?.workerId ?? null,
            worktreeId: context?.worktreeId ?? null,
            ...input.probeChanges,
          };
          const resolution = await prepared.resolve(probe);
          const claim = {
            cycle: {
              ...cycle,
              selectedTaskWorkerId: taskWorker.id,
              modelRouteId: resolution.modelRouteId ?? null,
              providerAccountId: resolution.providerAccountId ?? null,
              ...input.runtimeProbeChanges,
            },
          };
          resolutions.push({
            cycleId: cycle.id,
            taskWorkerId: taskWorker.id,
            resolution,
            runtime: prepared.runtimeForClaim(claim),
          });
        }
      }
    }
    let value = null,
      runtime = null;
    const options = { ...input.options };
    if (typeof options.now === "string") options.now = new Date(options.now);
    if (input.action === "claim") {
      value = await repository.taskDispatch.claimNext(
        input.owner,
        input.leaseOwner,
        prepared.resolve,
        options,
      );
      runtime = value ? prepared.runtimeForClaim(value) : null;
    } else if (input.action === "resume")
      value = await repository.taskDispatch.resumeNextPaused(
        input.owner,
        input.leaseOwner,
        prepared,
        options,
      );
    return { value, runtime, resolutions, hydration, logs };
  } finally {
    while (pending.size) await Promise.allSettled([...pending]);
  }
}
