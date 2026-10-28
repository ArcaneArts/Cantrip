import { createRequire } from "node:module";
import { ProviderCredentialMigrationCoordinator } from "../../cantrip_server/src/models/provider-credential-migrations.ts";
import { ProviderAccountLifecycleService } from "../../cantrip_server/src/models/provider-account-lifecycle.ts";
import { ChatGptCatalogService } from "../../cantrip_server/src/models/chatgpt-catalog.ts";
import { GrokCatalogService } from "../../cantrip_server/src/models/grok-catalog.ts";
import { installProviderAccountAuthRoutes } from "../../cantrip_server/src/app/routes/provider-account-auth.ts";
import { ProviderAccountReconnectRequiredError } from "../../cantrip_server/src/app/shared/errors.ts";
import { markProviderAccountReauthenticationRequired } from "../../cantrip_server/src/models/provider-account-reauth.ts";
import { installSettingsRouteRuntime } from "../../cantrip_server/src/app/runtime/settings-routes.ts";
import { OpenRouterRuntimeCatalogHydrator } from "../../cantrip_server/src/models/openrouter-runtime-catalog.ts";
import { serverLogger } from "../../cantrip_server/src/logger.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { sql } = require("drizzle-orm");
export async function providerServiceOperation(repo, r) {
  const input = r.input ?? {},
    calls = [],
    logs = [],
    invalidations = [],
    disconnected = new Set();
  let completedCalls = 0;
  let clock = input.now ?? 1000;
  const execute = async (statements) => {
    for (const statement of statements ?? [])
      await repo.settings.database.execute(sql.raw(statement));
  };
  const connected = (worker) =>
    !disconnected.has(worker) &&
    (typeof input.connected === "boolean"
      ? input.connected
      : input.connected?.[worker] === true);
  const bridge = {
    isConnected: connected,
    async request(worker, command, options) {
      const response =
        input.accounts?.[command.providerAccountId]?.[command.type] ??
        input.workers?.[worker] ??
        input.byType?.[command.type] ??
        input;
      const call = { worker, command, options };
      calls.push(call);
      if (input.observeClear)
        call.credentialCleared =
          (await repo.getModelProviderAccountCredential(
            options.ownerId,
            command.providerId,
            command.providerAccountId,
          )) === null;
      try {
        await execute(response.beforeSQL);
        clock += response.elapsedMs ?? 0;
        if (input.rejectDisconnected && !connected(worker))
          throw new Error("controlled disconnected worker");
        if (response.error) throw new Error(response.error);
        return response.reply;
      } finally {
        completedCalls++;
      }
    },
  };
  let result;
  if (r.op === "runtime-catalog") {
    const original = {
      now: Date.now,
      event: serverLogger.event,
      rateLimited: serverLogger.rateLimited,
    };
    const event = (level, message, context) => {
      logs.push({ level, message, context });
      if (input.logError === level)
        throw new Error("controlled diagnostic failure");
    };
    serverLogger.event = event;
    serverLogger.rateLimited = (key, level, message, context, options) => {
      logs.push({ key, level, message, context, options });
      if (input.logError === level)
        throw new Error("controlled diagnostic failure");
    };
    Date.now = () => clock;
    const service = (kind) => ({
      async getProviderCatalog(owner, provider, ...args) {
        const call = { kind, owner, provider };
        if (kind === "public") call.force = args[0];
        else if (kind !== "zai") {
          call.worker = args[0];
          call.force = args[1];
          if (kind === "chatgpt" || kind === "grok") {
            call.account = args[2];
            call.trigger = args[3];
          }
        }
        calls.push(call);
        await execute(input.beforeCatalogSQL);
        clock += input.elapsedMs ?? 0;
        if (input.catalogError) throw new Error(input.catalogError);
        return input.catalog === undefined
          ? { fixture: "catalog" }
          : input.catalog;
      },
    });
    const publicService = service("public");
    const hydrator = new OpenRouterRuntimeCatalogHydrator(async (provider) => {
      try {
        return Boolean(
          await publicService.getProviderCatalog(r.owner, provider, false),
        );
      } catch (error) {
        event("warn", "Unable to hydrate OpenRouter model metadata", {
          providerId: provider,
          error: error.message,
        });
        return false;
      }
    });
    let runtime;
    try {
      runtime = installSettingsRouteRuntime(
        { get() {}, post() {}, patch() {}, delete() {}, put() {} },
        {
          applicationOwnerId: () =>
            input.ambientOwner ?? "unrelated-ambient-owner",
          bridge,
          repository: repo,
          zaiCatalogService: service("zai"),
          providerCatalogService: publicService,
          chatGptCatalogService: service("chatgpt"),
          grokCatalogService: service("grok"),
          ollamaCatalogService: service("ollama"),
          openRouterRuntimeCatalogs: hydrator,
        },
      );
      const pending = runtime.loadProviderCatalog(
        r.owner,
        r.provider,
        r.worker,
        r.force ?? false,
        r.account,
        r.trigger,
      );
      if (input.discard) {
        let complete;
        const completion = new Promise((resolve) => {
          complete = resolve;
        });
        void pending.then(complete, complete);
        await completion;
        result = null;
      } else {
        try {
          result = await pending;
          if (input.hydrateAfterLoad)
            result = {
              catalog: result,
              hydrated: await hydrator.hydrate([
                {
                  provider: {
                    id: r.provider,
                    kind: "openai-compatible",
                    baseUrl: "https://openrouter.ai/api/v1",
                  },
                },
              ]),
            };
        } catch (error) {
          result = { error: error.message };
        }
      }
    } finally {
      if (runtime) clearInterval(runtime.workerCatalogRefreshTimer);
      Date.now = original.now;
      serverLogger.event = original.event;
      serverLogger.rateLimited = original.rateLimited;
    }
  } else if (r.op.startsWith("auth-")) {
    const migration = new ProviderCredentialMigrationCoordinator(repo, bridge, {
      purgeEnabledKinds: new Set(input.purgeKinds ?? []),
    });
    const unused = () => {
      throw new Error("Unexpected auth helper dependency");
    };
    const runtime = installProviderAccountAuthRoutes(
      { get() {}, post() {}, patch() {}, delete() {} },
      {
        activeProviderAuthObservation: unused,
        activeProviderAuthObservations: new Map(),
        applicationOwnerId: () => r.owner,
        bridge,
        loadProviderCatalog: unused,
        providerAccountLifecycle: undefined,
        providerCredentialMigrations: migration,
        publishLiveInvalidation: unused,
        publishProviderAuthStatus: unused,
        removeProviderAuthObservations: unused,
        repository: repo,
      },
    );
    try {
      if (r.op === "auth-reauth")
        result = await markProviderAccountReauthenticationRequired(repo, {
          ownerId: r.owner,
          providerId: r.provider,
          accountId: r.account,
        });
      else {
        const target = await runtime.resolveAccountAuthTarget(
          r.provider,
          r.account,
        );
        if (r.op === "auth-resolve") result = target;
        else {
          const pending = runtime.prepareProviderAccountSignOut(
            target,
            r.provider,
            r.worker,
          );
          if (input.discard) {
            void pending.catch(() => {});
            const deadline = performance.now() + 5000;
            while (completedCalls < input.waitForCalls) {
              if (performance.now() > deadline)
                throw new Error("Unobserved auth preparation did not complete");
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
          } else await pending;
          result = null;
        }
      }
    } catch (error) {
      result = {
        error: error.message,
        reconnectRequired:
          error instanceof ProviderAccountReconnectRequiredError,
      };
    }
  } else if (r.op === "lifecycle-signout") {
    let complete;
    const completed = new Promise((resolve) => {
      complete = resolve;
    });
    const log = (level, context, message) => {
      logs.push({ level, context, message });
      if (context.event === "provider.account.sign_out_completed") complete();
      if (input.logError === level)
        throw new Error("controlled diagnostic failure");
    };
    const logger = {
      warn: (context, message) => log("warn", context, message),
      ...(input.noInfo
        ? {}
        : { info: (context, message) => log("info", context, message) }),
    };
    const lifecycle = new ProviderAccountLifecycleService(repo, bridge, {
      logger,
      invalidateCatalog: (context) => {
        if (input.disconnectOnInvalidate)
          disconnected.add(input.disconnectOnInvalidate);
        return (async () => {
          const credentialCleared =
            (await repo.getModelProviderAccountCredential(
              context.ownerId,
              context.providerId,
              context.accountId,
            )) === null;
          invalidations.push({ input: context, credentialCleared });
          await execute(input.invalidateSQL);
          if (input.invalidateError)
            throw new Error("controlled invalidation failure");
          await new (context.kind === "grok"
            ? GrokCatalogService
            : ChatGptCatalogService)(repo, bridge).markAccountUnavailable(
            context.ownerId,
            context.providerId,
            context.accountId,
          );
        })();
      },
    });
    const original = Date.now;
    Date.now = () => clock;
    try {
      const pending = lifecycle.signOut({
        ownerId: r.owner,
        providerId: r.provider,
        accountId: r.account,
        kind: r.kind,
        credentialHomeKey: r.home,
      });
      if (input.discard) {
        void pending.catch(() => {});
        let timer;
        try {
          await Promise.race([
            completed,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Unobserved sign-out did not complete")),
                5000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        result = null;
      } else result = await pending;
    } finally {
      Date.now = original;
    }
  } else {
    const migration = new ProviderCredentialMigrationCoordinator(repo, bridge, {
      purgeEnabledKinds: new Set(input.purgeKinds ?? []),
    });
    const pending =
      r.op === "migration-worker"
        ? migration.migrateWorker(r.owner, r.worker)
        : migration.captureAccount(r.owner, r.worker, r.provider, r.account);
    if (input.discard) {
      void pending.catch(() => {});
      const deadline = performance.now() + 5000;
      while (
        (
          await repo.getModelProviderAccountCredential(
            r.owner,
            r.provider,
            r.account,
          )
        )?.state !== "signed-in"
      ) {
        if (performance.now() > deadline)
          throw new Error("Unobserved credential capture did not commit");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      result = null;
    } else result = await pending;
  }
  return { result, calls, logs, invalidations };
}
