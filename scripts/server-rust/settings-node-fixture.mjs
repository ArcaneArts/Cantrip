// Disposable IPC driver of the real production repository and collaborators.
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { readServerConfig } from "../../cantrip_server/src/config.ts";
import { connectDatabase } from "../../cantrip_server/src/db/index.ts";
import { catalogMetadataSnapshot } from "../../cantrip_server/src/db/repository/provider-catalog.ts";
import { OllamaCatalogService } from "../../cantrip_server/src/models/ollama-catalog.ts";
import { ChatGptCatalogService } from "../../cantrip_server/src/models/chatgpt-catalog.ts";
import { GrokCatalogService } from "../../cantrip_server/src/models/grok-catalog.ts";
import { serverLogger } from "../../cantrip_server/src/logger.ts";
import { OpenRouterCatalogService } from "../../cantrip_server/src/models/openrouter-catalog.ts";
import { providerServiceOperation } from "./settings-provider-service-fixture.mjs";
import {
  persistProviderQuotaSnapshot,
  readAndPersistProviderQuotaSnapshot,
  persistProviderRateLimitActivity,
} from "../../cantrip_server/src/models/provider-quota.ts";
import {
  ZaiCatalogService,
  isZaiCodingPlanProvider,
  ZAI_CODEX_MODELS,
  ZAI_CODEX_CATALOG_VERSION,
  ZAI_CODEX_CATALOG_SCOPE,
  ZAI_CODEX_CATALOG_SOURCE,
} from "../../cantrip_server/src/models/zai-catalog.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { sql } = require("drizzle-orm");
const database = await connectDatabase(readServerConfig());
const repo = database.repository;
const publicCatalog = { input: {}, calls: [], now: 1000, release: null };
const publicOptions = {
  now: () => publicCatalog.now,
  ttlMs: 100,
  fetch: async (url, options) => {
    const input = publicCatalog.input;
    const headers = new Headers(options.headers);
    publicCatalog.calls.push({
      url: String(url),
      etag: headers.get("if-none-match"),
      accept: headers.get("accept"),
      authorization: headers.get("authorization"),
    });
    if (input.block)
      await new Promise((resolve) => {
        publicCatalog.release = resolve;
      });
    if (input.error) throw new Error(input.error);
    const response = new Response(
      input.status === 304 ? null : JSON.stringify(input.payload ?? {}),
      {
        status: input.status ?? 200,
        statusText: input.statusText ?? "OK",
        headers:
          input.etag === undefined || input.etag === null
            ? {}
            : { etag: input.etag },
      },
    );
    return response;
  },
};
const openRouter = new OpenRouterCatalogService(repo, publicOptions);
const grokRequest = { input: {}, calls: [], diagnostics: [], active: false };
const grok = new GrokCatalogService(
  repo,
  {
    isConnected: () => grokRequest.input.connected ?? false,
    async request(worker, command, options) {
      grokRequest.calls.push({ worker, command, options });
      const response =
        grokRequest.input.responses?.[command.provider.accountId] ??
        grokRequest.input;
      if (response.error) throw new Error(response.error);
      return response.inventory;
    },
  },
  publicOptions,
);
const originalRateLimited = serverLogger.rateLimited;
serverLogger.rateLimited = (key, level, message, context, options) => {
  if (grokRequest.active)
    grokRequest.diagnostics.push({ key, level, message, context, options });
  originalRateLimited(key, level, message, context, options);
};
console.log(
  JSON.stringify({
    event: "server.listening",
    origin: "settings-repository-fixture",
  }),
);
try {
  for await (const line of createInterface({ input: process.stdin })) {
    const r = JSON.parse(line);
    try {
      let value;
      switch (r.op) {
        case "migration-worker":
        case "migration-account":
        case "lifecycle-signout":
        case "auth-resolve":
        case "auth-prepare":
        case "auth-reauth":
        case "runtime-catalog":
          value = await providerServiceOperation(repo, r);
          break;
        case "grok-get":
        case "grok-unavailable":
          grokRequest.input = r.input ?? {};
          grokRequest.calls = [];
          grokRequest.diagnostics = [];
          grokRequest.active = true;
          publicCatalog.input = r.input?.public ?? {};
          publicCatalog.calls = [];
          publicCatalog.now = r.now ?? publicCatalog.now;
          try {
            const result =
              r.op === "grok-get"
                ? await grok.getProviderCatalog(
                    r.owner,
                    r.provider,
                    r.worker,
                    r.force,
                    r.account,
                    r.trigger,
                  )
                : await grok.markAccountUnavailable(
                    r.owner,
                    r.provider,
                    r.account,
                  );
            value = {
              result: result ?? null,
              calls: grokRequest.calls,
              publicCalls: publicCatalog.calls,
              diagnostics: grokRequest.diagnostics,
            };
          } catch (error) {
            value = {
              error: error.message,
              calls: grokRequest.calls,
              publicCalls: publicCatalog.calls,
              diagnostics: grokRequest.diagnostics,
            };
          } finally {
            grokRequest.active = false;
          }
          break;
        case "openrouter-get":
          publicCatalog.input = r.input;
          publicCatalog.calls = [];
          publicCatalog.now = r.now ?? publicCatalog.now;
          try {
            value = {
              result: await openRouter.getProviderCatalog(
                r.owner,
                r.provider,
                r.force,
              ),
              calls: publicCatalog.calls,
            };
          } catch (error) {
            value = { error: error.message, calls: publicCatalog.calls };
          }
          break;
        case "openrouter-release": {
          if (!publicCatalog.release)
            throw new Error("No pending public catalog request.");
          publicCatalog.release();
          publicCatalog.release = null;
          const deadline = Date.now() + 5000;
          do {
            value = await repo.getProviderModelCatalog(
              r.owner,
              r.provider,
              false,
            );
            if (
              value?.syncStates.some(
                (state) =>
                  state.scopeKey === "openrouter:global" &&
                  state.status === r.status &&
                  state.error === r.error &&
                  (r.etag === undefined || state.etag === r.etag),
              )
            )
              break;
            if (Date.now() >= deadline)
              throw new Error("Public catalog persistence did not settle.");
            await new Promise((resolve) => setTimeout(resolve, 5));
          } while (true);
          break;
        }
        case "quota-observe":
          value = await repo.recordProviderQuotaObservation(r.owner, {
            ...r.input,
            observedAt: new Date(r.input.observedAt),
            resetsAt:
              r.input.resetsAt === null ? null : new Date(r.input.resetsAt),
          });
          break;
        case "quota-persist":
          value = await persistProviderQuotaSnapshot(
            repo,
            { ...r.context, ownerId: r.owner },
            r.input,
          );
          break;
        case "quota-activity": {
          const original = Date.now;
          try {
            Date.now = () => r.now;
            value = await persistProviderRateLimitActivity(
              repo,
              { ...r.context, ownerId: r.owner },
              r.input,
            );
          } finally {
            Date.now = original;
          }
          break;
        }
        case "chatgpt-unavailable":
          await new ChatGptCatalogService(repo, {}).markAccountUnavailable(
            r.owner,
            r.provider,
            r.account,
          );
          value = null;
          break;
        case "chatgpt-get":
        case "quota-read":
        case "ollama-get": {
          const calls = [];
          const bridge = {
            isConnected: () => r.input.connected ?? false,
            async request(worker, command, options) {
              calls.push({ worker, command, options });
              const response =
                r.input.responses?.[command.provider.accountId] ?? r.input;
              if (response.error) throw new Error(response.error);
              return response.inventory;
            },
          };
          try {
            value = {
              result:
                r.op === "chatgpt-get"
                  ? await new ChatGptCatalogService(
                      repo,
                      bridge,
                    ).getProviderCatalog(
                      r.owner,
                      r.provider,
                      r.worker,
                      r.force,
                      r.account,
                      r.trigger,
                    )
                  : r.op === "quota-read"
                    ? await readAndPersistProviderQuotaSnapshot(repo, bridge, {
                        ...r.context,
                        ownerId: r.owner,
                      })
                    : await new OllamaCatalogService(
                        repo,
                        bridge,
                      ).getProviderCatalog(
                        r.owner,
                        r.provider,
                        r.worker,
                        r.force,
                      ),
              calls,
            };
          } catch (error) {
            value = { error: error.message, calls };
          }
          break;
        }
        case "zai-get":
          value = await new ZaiCatalogService(repo).getProviderCatalog(
            r.owner,
            r.provider,
          );
          break;
        case "zai-reconcile":
          value = await new ZaiCatalogService(repo).reconcileOwnerProviders(
            r.owner,
          );
          break;
        case "zai-predicate":
          value = isZaiCodingPlanProvider(r.input);
          break;
        case "zai-constants":
          value = {
            version: ZAI_CODEX_CATALOG_VERSION,
            scope: ZAI_CODEX_CATALOG_SCOPE,
            source: ZAI_CODEX_CATALOG_SOURCE,
            models: ZAI_CODEX_MODELS,
          };
          break;
        case "catalog-hash":
          value = catalogMetadataSnapshot(r.input);
          break;
        case "sql":
          await repo.settings.database.execute(sql.raw(r.sql));
          value = null;
          break;
        case "transaction":
          await repo.settings.database.transaction(async (tx) => {
            for (const statement of r.statements)
              await tx.execute(sql.raw(statement));
          });
          value = null;
          break;
        case "query-json": {
          const result = await repo.settings.database.execute(sql.raw(r.sql));
          value =
            (Array.isArray(result) ? result : result.rows)[0]?.result ?? null;
          break;
        }
        case "ensure-account":
          await repo.ensureAccountConfiguration(r.owner);
          value = null;
          break;
        case "ensure-default":
          await repo.ensureDefaultModelConfiguration(
            r.owner,
            r.model,
            r.baseUrl,
          );
          value = null;
          break;
        case "settings":
          value = await repo.getSettings(r.owner);
          break;
        case "preferences":
          value = await repo.getUserSettings(r.owner);
          break;
        case "update":
          value = await repo.updateSettings(r.owner, r.input);
          break;
        case "destination":
          value = await repo.updateAppDestination(r.owner, r.input);
          break;
        case "runtimes":
          value = await repo.getModelRuntimes(
            r.owner,
            r.model,
            r.route,
            r.includeDisabled,
            r.provider,
          );
          break;
        case "model-create":
          value = await repo.createModelProfile(r.owner, r.input);
          break;
        case "model-update":
          value = await repo.updateModelProfile(r.owner, r.model, r.input);
          break;
        case "model-delete":
          value = await repo.deleteModelProfile(r.owner, r.model);
          break;
        case "provider-create":
          value = await repo.createModelProvider(r.owner, r.input);
          break;
        case "provider-get":
          value = await repo.getModelProvider(r.owner, r.provider);
          break;
        case "provider-update":
          value = await repo.updateModelProvider(r.owner, r.provider, r.input);
          break;
        case "provider-delete":
          value = await repo.deleteModelProvider(r.owner, r.provider);
          break;
        case "provider-runtime":
          value = await repo.getModelProviderCatalogRuntime(
            r.owner,
            r.provider,
          );
          break;
        case "provider-routes":
          value = await repo.hasModelRoutesForProvider(r.owner, r.provider);
          break;
        case "account-runtimes":
          value = await repo.listModelProviderAccountRuntimes(
            r.owner,
            r.provider,
            r.worker,
            r.model ?? null,
          );
          break;
        case "accounts-list":
          value = await repo.listModelProviderAccounts(r.owner, r.provider);
          break;
        case "account-create":
          value = await repo.createModelProviderAccount(
            r.owner,
            r.provider,
            r.input,
          );
          break;
        case "account-update":
          value = await repo.updateModelProviderAccount(
            r.owner,
            r.provider,
            r.account,
            r.input,
          );
          break;
        case "accounts-order":
          value = await repo.reorderModelProviderAccounts(
            r.owner,
            r.provider,
            r.input,
          );
          break;
        case "account-delete":
          value = await repo.deleteModelProviderAccount(
            r.owner,
            r.provider,
            r.account,
          );
          break;
        case "account-runtime":
          value = await repo.getModelProviderAccountRuntime(
            r.owner,
            r.provider,
            r.account,
          );
          break;
        case "credential-get":
          value = await repo.getModelProviderAccountCredential(
            r.owner,
            r.provider,
            r.account,
          );
          break;
        case "credential-migrations":
          value = await repo.listModelProviderAccountCredentialMigrations(
            r.owner,
          );
          break;
        case "credential-migration":
          value = await repo.getModelProviderAccountCredentialMigration(
            r.owner,
            r.provider,
            r.account,
          );
          break;
        case "credential-store":
          value = await repo.storeModelProviderAccountCredential(
            r.owner,
            r.provider,
            r.account,
            r.input,
            r.metadata,
            r.expectedRevision,
          );
          break;
        case "credential-state":
          value = await repo.updateModelProviderAccountCredentialState({
            ownerId: r.owner,
            providerId: r.provider,
            accountId: r.account,
            expectedRevision: r.expectedRevision,
            state: r.state,
          });
          break;
        case "credential-clear":
          value = await repo.clearModelProviderAccountCredential(
            r.owner,
            r.provider,
            r.account,
            r.expectedRevision,
          );
          break;
        case "credential-signout":
          value = await repo.takeModelProviderAccountCredentialForSignOut(
            r.owner,
            r.provider,
            r.account,
            r.expectedRevision,
          );
          break;
        case "credential-parallel":
          value = await Promise.all(
            Array.from({ length: r.count }, async () => {
              try {
                return {
                  value: await repo.storeModelProviderAccountCredential(
                    r.owner,
                    r.provider,
                    r.account,
                    r.input,
                    r.metadata,
                    r.expectedRevision,
                  ),
                };
              } catch (error) {
                return { error: error.message };
              }
            }),
          );
          break;
        case "account-status":
          await repo.recordModelProviderAccountStatus(
            r.account,
            r.worker,
            r.status,
          );
          value = null;
          break;
        case "account-credits":
          value = await repo.recordModelProviderAccountCredits({
            ownerId: r.owner,
            providerId: r.provider,
            accountId: r.account,
            credits: r.credits,
            observedAt: new Date(r.observedAt),
          });
          break;
        case "account-usage":
          value = await repo.recordModelProviderAccountUsage({
            ownerId: r.owner,
            providerId: r.provider,
            accountId: r.account,
            planType: r.planType ?? null,
            resetsAt: r.resetsAt ?? null,
            usedPercent:
              typeof r.usedPercent === "string"
                ? Number(r.usedPercent)
                : r.usedPercent,
          });
          break;
        case "catalog-targets":
          value = await repo.listModelProviderCatalogTargets(r.owner);
          break;
        case "catalog-refresh-targets":
          value = await repo.listModelProviderRefreshTargets(r.owner);
          break;
        case "catalog-sync": {
          const input = { ...r.input };
          for (const key of ["refreshStartedAt", "lastSuccessAt"])
            if (input[key]) input[key] = new Date(input[key]);
          await repo.setProviderCatalogSyncState(r.provider, input);
          value = null;
          break;
        }
        case "catalog-get":
          value = await repo.getProviderModelCatalog(
            r.owner,
            r.provider,
            r.servedStale,
          );
          break;
        case "catalog-availability":
          value = await repo.listProviderModelAvailability(
            r.owner,
            r.provider,
            r.model,
          );
          break;
        case "catalog-reconcile":
          value = await repo.reconcileProviderModelCatalog(
            r.owner,
            r.provider,
            {
              ...r.input,
              availableNativeModelIds: new Set(r.input.availableNativeModelIds),
              ...(r.input.autoCreateNativeModelIds === undefined
                ? {}
                : {
                    autoCreateNativeModelIds: new Set(
                      r.input.autoCreateNativeModelIds,
                    ),
                  }),
            },
          );
          break;
        case "analytics": {
          const a = await repo.getAgentTimeAnalytics(
            r.owner,
            r.project,
            new Date(r.now),
          );
          value = {
            total: a.total,
            models: Object.fromEntries(a.models),
            providers: Object.fromEntries(a.providers),
          };
          break;
        }
        default:
          throw new Error("Unknown settings fixture operation: " + r.op);
      }
      console.log(JSON.stringify({ id: r.id, rejected: false, value }));
    } catch (error) {
      console.log(
        JSON.stringify({
          id: r.id,
          rejected: true,
          diagnostic: error.cause?.message ?? error.message,
          kind:
            error.name === "ProviderCredentialIdentityConflictError"
              ? "credential-identity"
              : error.name === "ProviderCredentialRevisionConflictError"
                ? "credential-revision"
                : undefined,
        }),
      );
    }
  }
} finally {
  await database.close();
}
