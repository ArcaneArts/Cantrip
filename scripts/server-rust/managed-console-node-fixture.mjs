// Actual reference routing/console services over the disposable real repository.
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { sql } = require("drizzle-orm");
import { createModelRoutingRuntime } from "../../cantrip_server/src/app/runtime/model-routing-runtime.ts";
import {
  prepareManagedConsoleLaunch,
  managedConsoleSessionContext,
} from "../../cantrip_server/src/terminals/managed-session.ts";
import { effectivePermissionProfile } from "../../cantrip_server/src/chats/execution-helpers.ts";
import { evaluateModelRouteAvailability } from "../../cantrip_server/src/models/model-route-availability.ts";
import { resolveAccountProviderRuntimes } from "../../cantrip_server/src/models/chatgpt-account-routing.ts";
import { shouldUseChatGptCredits } from "../../packages/protocol/src/providers.ts";
import { serverLogger } from "../../cantrip_server/src/logger.ts";

export async function managedConsoleFixture(repository, request, trace) {
  const execute = (statement) =>
    repository.projects.database.execute(sql.raw(statement));
  const bridge = {
    isConnected: () => request.connected !== false,
    async request(worker, command, options) {
      trace.push({ type: "ensure", worker, command, options });
      if (request.ensureSql) await execute(request.ensureSql);
      if (request.ensureError) throw new Error(request.ensureError);
      return request.ensureOmitted
        ? undefined
        : Object.hasOwn(request, "ensureResult")
          ? request.ensureResult
          : { threadId: "fixture-console-thread" };
    },
  };
  const routing = createModelRoutingRuntime({
    app: { log: {} },
    applicationOwnerId: () => request.owner,
    bridge,
    openRouterRuntimeCatalogs: {
      async hydrate(runtimes) {
        trace.push({
          type: "hydrate",
          owner: request.owner,
          routes: runtimes.map((r) => r.routeId),
        });
        if (request.hydrateSql) {
          await execute(request.hydrateSql);
          return true;
        }
        return false;
      },
    },
    publishLiveInvalidation() {},
    publishProjectTokenUsageChange() {},
    repository,
    routeCooldowns: new Map(request.cooldowns ?? []),
    runtimeCooldownKey: (runtime) =>
      ["chatgpt", "grok"].includes(runtime.provider.kind) &&
      runtime.provider.accountId
        ? `${runtime.routeId}:account:${runtime.provider.accountId}`
        : runtime.routeId,
  });
  const previousNow = Date.now;
  const previousLogs = {
    sampled: serverLogger.sampled,
    rateLimited: serverLogger.rateLimited,
  };
  if (
    ![
      "console-credits",
      "console-eligibility",
      "console-accounts",
      "console-permission",
    ].includes(request.op)
  ) {
    serverLogger.sampled = (key, every, level, message, event) =>
      trace.push({
        type: "log",
        policy: "sampled",
        key,
        every,
        level,
        message,
        event,
      });
    serverLogger.rateLimited = (key, level, message, event, options) =>
      trace.push({
        type: "log",
        policy: "repeated",
        key,
        level,
        message,
        event,
        ...(options === undefined ? {} : { options }),
      });
  }
  if (request.now !== undefined) Date.now = () => request.now;
  try {
    if (request.op === "console-credits")
      return shouldUseChatGptCredits(request.credits);
    if (request.op === "console-eligibility")
      return evaluateModelRouteAvailability(
        request.runtime,
        request.availability ?? [],
        request.worker,
      );
    if (request.op === "console-accounts")
      return resolveAccountProviderRuntimes({
        ownerId: request.owner,
        workerId: request.worker,
        preferredAccountId: request.preferred,
        runtime: request.runtime,
        repository: {
          listModelProviderAccountRuntimes: async () => request.accounts,
        },
      });
    const context =
      request.context ??
      (await repository.getChatExecutionContext(request.owner, request.chat));
    if (request.op === "console-permission")
      return {
        permission: effectivePermissionProfile(context),
        session: managedConsoleSessionContext(context) ?? null,
      };
    if (request.op === "console-model")
      return await routing.resolveModelId(context, request.requested);
    if (request.op === "console-available")
      return await routing.availableModelRuntimes(context, request.model);
    if (request.op === "console-context")
      return await routing.runtimeForContext(context);
    if (request.op === "console-pairs")
      return await routing.routePairsForConfiguration(
        context,
        request.configuration,
        request.roots,
      );
    if (request.op === "console-launch") {
      const runtime =
        request.runtime ?? (await routing.runtimeForContext(context));
      return await prepareManagedConsoleLaunch(context, runtime, {
        ownerId: request.owner,
        bridge,
        repository,
        routePairsForConfiguration: routing.routePairsForConfiguration,
      });
    }
    throw new Error("Unknown console fixture operation");
  } finally {
    Date.now = previousNow;
    Object.assign(serverLogger, previousLogs);
  }
}
