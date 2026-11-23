import { randomUUID } from "node:crypto";

import {
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  encryptedModelProviderAccountCreateSchema,
  encryptedModelProviderAccountUpdateSchema,
  modelProviderAccountWireListSchema,
  modelProviderAccountWireSummarySchema,
  orderedIdsSchema,
  PROVIDER_REAUTH_REQUIRED_ERROR_CODE,
  PROVIDER_REAUTH_REQUIRED_MESSAGE,
  providerQuotaSnapshotSchema,
  providerRateLimitResetConsumeRequestSchema,
  providerRateLimitResetConsumeResultSchema,
  providerTelemetryDeleteResultSchema,
  providerTelemetryExportSchema,
  providerTelemetryWireAnalyticsSchema,
  type ProviderAuthLiveStatus,
} from "@cantrip/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import { isAccountProviderKind } from "../../models/account-provider.js";
import type { ProviderAccountLifecycleService } from "../../models/provider-account-lifecycle.js";
import { providerAccountAuthStatus } from "../../models/provider-account-status.js";
import {
  isProviderAccountReauthenticationRequired,
  markProviderAccountReauthenticationRequired,
} from "../../models/provider-account-reauth.js";
import type { ProviderCredentialMigrationCoordinator } from "../../models/provider-credential-migrations.js";
import {
  persistProviderQuotaSnapshot,
  readAndPersistProviderQuotaSnapshot,
} from "../../models/provider-quota.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import { ProviderAccountReconnectRequiredError } from "../shared/errors.js";

interface ProviderAuthObservation {
  accountId: string;
  expiresAt: number;
  lastSequence: number;
  ownerId: string;
  providerId: string;
  providerKind: "chatgpt" | "grok";
  startedAt: number;
  workerId: string;
}

type ActiveProviderAuthObservation = [
  observationId: string,
  observation: ProviderAuthObservation,
];

export interface ProviderAccountAuthRouteDependencies {
  activeProviderAuthObservation: (
    ownerId: string,
    providerId: string,
    accountId: string,
  ) => ActiveProviderAuthObservation | null;
  activeProviderAuthObservations: Map<string, ProviderAuthObservation>;
  applicationOwnerId: () => string;
  bridge: LimitedWorkerCommandBus;
  loadProviderCatalog: (
    ownerId: string,
    providerId: string,
    workerId: string | undefined,
    force: boolean,
    accountId?: string,
    quotaTrigger?: string,
  ) => Promise<unknown>;
  providerAccountLifecycle: ProviderAccountLifecycleService;
  providerCredentialMigrations: ProviderCredentialMigrationCoordinator;
  publishLiveInvalidation: (resource: "settings") => void;
  publishProviderAuthStatus: (
    status: Omit<ProviderAuthLiveStatus, "revision">,
  ) => ProviderAuthLiveStatus;
  removeProviderAuthObservations: (
    ownerId: string,
    providerId: string,
    accountId: string,
  ) => void;
  repository: ServerRepository;
}

/** Registers provider accounts, quota telemetry, and Codex account auth routes. */
export function installProviderAccountAuthRoutes(
  app: FastifyInstance,
  {
    activeProviderAuthObservation,
    activeProviderAuthObservations,
    applicationOwnerId,
    bridge,
    loadProviderCatalog,
    providerAccountLifecycle,
    providerCredentialMigrations,
    publishLiveInvalidation,
    publishProviderAuthStatus,
    removeProviderAuthObservations,
    repository,
  }: ProviderAccountAuthRouteDependencies,
) {
  app.get<{ Params: { providerId: string } }>(
    "/api/settings/providers/:providerId/accounts",
    async (request, reply) => {
      const accounts = await repository.listModelProviderAccounts(
        applicationOwnerId(),
        request.params.providerId,
      );
      return accounts
        ? reply.send(modelProviderAccountWireListSchema.parse(accounts))
        : reply.code(404).send({ error: "Account provider not found." });
    },
  );

  app.get<{
    Querystring: {
      providerId?: string;
      providerAccountId?: string;
      modelId?: string;
      reasoningEffort?: string;
      projectId?: string;
      days?: string;
    };
  }>("/api/analytics/provider-telemetry", async (request, reply) => {
    const parsedDays = Number.parseInt(request.query.days ?? "90", 10);
    const days = Number.isFinite(parsedDays)
      ? Math.min(365, Math.max(1, parsedDays))
      : 90;
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const analytics = await repository.getProviderTelemetryAnalytics(
      applicationOwnerId(),
      {
        providerId: request.query.providerId || undefined,
        providerAccountId: request.query.providerAccountId || undefined,
        modelId: request.query.modelId || undefined,
        reasoningEffort: request.query.reasoningEffort || undefined,
        projectId: request.query.projectId || undefined,
        from,
        to,
      },
    );
    return reply.send(providerTelemetryWireAnalyticsSchema.parse(analytics));
  });

  app.get<{ Params: { providerId: string } }>(
    "/api/analytics/provider-telemetry/:providerId/export",
    async (request, reply) => {
      const exported = await repository.exportProviderTelemetry(
        applicationOwnerId(),
        request.params.providerId,
      );
      return exported
        ? reply.send(providerTelemetryExportSchema.parse(exported))
        : reply.code(404).send({ error: "Model provider not found." });
    },
  );

  app.delete<{ Params: { providerId: string } }>(
    "/api/analytics/provider-telemetry/:providerId",
    async (request, reply) => {
      const result = await repository.deleteProviderTelemetry(
        applicationOwnerId(),
        request.params.providerId,
      );
      return result
        ? reply.send(providerTelemetryDeleteResultSchema.parse(result))
        : reply.code(404).send({ error: "Model provider not found." });
    },
  );

  app.post<{
    Params: { providerId: string };
    Body: unknown;
  }>("/api/settings/providers/:providerId/accounts", async (request, reply) => {
    const input = encryptedModelProviderAccountCreateSchema.safeParse(
      request.body,
    );
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    const account = await repository.createModelProviderAccount(
      applicationOwnerId(),
      request.params.providerId,
      input.data,
    );
    return account
      ? reply
          .code(201)
          .send(modelProviderAccountWireSummarySchema.parse(account))
      : reply.code(404).send({ error: "Account provider not found." });
  });

  app.patch<{
    Params: { providerId: string };
    Body: unknown;
  }>(
    "/api/settings/providers/:providerId/accounts/order",
    async (request, reply) => {
      const input = orderedIdsSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      return (await repository.reorderModelProviderAccounts(
        applicationOwnerId(),
        request.params.providerId,
        input.data,
      ))
        ? reply.code(204).send()
        : reply
            .code(400)
            .send({ error: "Provider account order did not match." });
    },
  );

  app.patch<{
    Params: { providerId: string; accountId: string };
    Body: unknown;
  }>(
    "/api/settings/providers/:providerId/accounts/:accountId",
    async (request, reply) => {
      const input = encryptedModelProviderAccountUpdateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const account = await repository.updateModelProviderAccount(
        applicationOwnerId(),
        request.params.providerId,
        request.params.accountId,
        input.data,
      );
      return account
        ? reply.send(modelProviderAccountWireSummarySchema.parse(account))
        : reply.code(404).send({ error: "Provider account not found." });
    },
  );

  app.delete<{
    Params: { providerId: string; accountId: string };
  }>(
    "/api/settings/providers/:providerId/accounts/:accountId",
    async (request, reply) => {
      try {
        const account = await resolveAccountAuthTarget(
          request.params.providerId,
          request.params.accountId,
        );
        await prepareProviderAccountSignOut(account, request.params.providerId);
        await providerAccountLifecycle.signOut({
          accountId: account.accountId,
          credentialHomeKey: account.credentialHomeKey,
          kind: account.providerKind,
          ownerId: applicationOwnerId(),
          providerId: request.params.providerId,
        });
        return (await repository.deleteModelProviderAccount(
          applicationOwnerId(),
          request.params.providerId,
          request.params.accountId,
        ))
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Provider account not found." });
      } catch (error) {
        const message = errorMessage(error);
        if (message.endsWith("not found.")) {
          return reply.code(404).send({ error: message });
        }
        if (error instanceof ProviderAccountReconnectRequiredError) {
          return reply.code(409).send({ error: message });
        }
        return sendWorkerRequestFailure(reply, error, message);
      }
    },
  );

  async function resolveAccountAuthTarget(
    providerId: string,
    accountId?: string,
  ) {
    const [provider, account, accounts] = await Promise.all([
      repository.getModelProvider(applicationOwnerId(), providerId),
      repository.getModelProviderAccountRuntime(
        applicationOwnerId(),
        providerId,
        accountId,
      ),
      repository.listModelProviderAccounts(applicationOwnerId(), providerId),
    ]);
    const summary = account
      ? accounts?.find(({ id }) => id === account.accountId)
      : null;
    if (
      !provider ||
      !isAccountProviderKind(provider.kind) ||
      !account ||
      !summary
    ) {
      throw new Error("Provider account not found.");
    }
    return {
      ...account,
      credentialState: summary.credentialState,
      planType: summary.planType,
      providerKind: provider.kind,
      workerBindings: summary.workerBindings,
    };
  }

  async function resolveChatGptRateLimitResetTarget(
    providerId: string,
    accountId: string,
    workerId: string,
  ) {
    const [account, provider, worker] = await Promise.all([
      resolveAccountAuthTarget(providerId, accountId),
      repository.getModelProvider(applicationOwnerId(), providerId),
      repository.getWorker(applicationOwnerId(), workerId),
    ]);
    if (!provider || provider.kind !== "chatgpt") {
      throw new Error(
        "Rate-limit reset credits are only available for ChatGPT accounts.",
      );
    }
    if (!worker) throw new Error("Worker not found.");
    if (!bridge.isConnected(workerId)) throw new Error("Worker is offline.");
    const legacyAvailable =
      account.credentialState === "migration-needed" &&
      account.workerBindings.some(
        (binding) =>
          binding.workerId === workerId && binding.authState === "signed-in",
      );
    if (account.credentialState !== "signed-in" && !legacyAvailable) {
      throw new Error("ChatGPT account is not signed in.");
    }
    return { account, provider };
  }

  async function sendProviderQuotaAuthenticationFailure(
    reply: FastifyReply,
    error: unknown,
    input: { accountId: string; providerId: string },
  ): Promise<FastifyReply | null> {
    if (!isProviderAccountReauthenticationRequired(error)) return null;
    await markProviderAccountReauthenticationRequired(repository, {
      ...input,
      ownerId: applicationOwnerId(),
    });
    publishLiveInvalidation("settings");
    return reply.code(409).send({
      code: PROVIDER_REAUTH_REQUIRED_ERROR_CODE,
      error: PROVIDER_REAUTH_REQUIRED_MESSAGE,
    });
  }

  app.get<{
    Params: { providerId: string; accountId: string };
    Querystring: { workerId?: string };
  }>(
    "/api/settings/providers/:providerId/accounts/:accountId/rate-limit-resets",
    async (request, reply) => {
      const workerId = request.query.workerId;
      if (!workerId) {
        return reply.code(400).send({ error: "workerId is required" });
      }
      try {
        const { account, provider } = await resolveChatGptRateLimitResetTarget(
          request.params.providerId,
          request.params.accountId,
          workerId,
        );
        const { snapshot } = await readAndPersistProviderQuotaSnapshot(
          repository,
          bridge,
          {
            ownerId: applicationOwnerId(),
            providerId: provider.id,
            accountId: account.accountId,
            accountPlanType: account.planType,
            workerId,
            trigger: "reset-credit-status",
            provider: {
              name: provider.name,
              kind: "chatgpt",
              baseUrl: provider.baseUrl,
              credentialHomeKey: account.credentialHomeKey,
            },
          },
        );
        publishLiveInvalidation("settings");
        return reply.send(providerQuotaSnapshotSchema.parse(snapshot));
      } catch (error) {
        const message = errorMessage(error);
        const authFailure = await sendProviderQuotaAuthenticationFailure(
          reply,
          error,
          {
            providerId: request.params.providerId,
            accountId: request.params.accountId,
          },
        );
        if (authFailure) return authFailure;
        if (message.endsWith("not found.")) {
          return reply.code(404).send({ error: message });
        }
        if (
          message.includes("only available for ChatGPT") ||
          message.includes("not signed in")
        ) {
          return reply.code(409).send({ error: message });
        }
        return sendWorkerRequestFailure(reply, error, message);
      }
    },
  );

  app.post<{
    Params: { providerId: string; accountId: string };
    Body: unknown;
  }>(
    "/api/settings/providers/:providerId/accounts/:accountId/rate-limit-resets/consume",
    async (request, reply) => {
      const input = providerRateLimitResetConsumeRequestSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const { account, provider } = await resolveChatGptRateLimitResetTarget(
          request.params.providerId,
          request.params.accountId,
          input.data.workerId,
        );
        const result = providerRateLimitResetConsumeResultSchema.parse(
          await bridge.request(
            input.data.workerId,
            {
              type: "provider.rate-limit-reset.consume",
              provider: {
                id: provider.id,
                name: provider.name,
                kind: "chatgpt",
                baseUrl: provider.baseUrl,
                protectedApiKey: null,
                accountId: account.accountId,
                credentialHomeKey: account.credentialHomeKey,
              },
              idempotencyKey: input.data.idempotencyKey,
              creditId: input.data.creditId,
            },
            { ownerId: applicationOwnerId(), timeoutMs: 2 * 60_000 },
          ),
        );
        if (result.quotaSnapshot) {
          try {
            await persistProviderQuotaSnapshot(
              repository,
              {
                ownerId: applicationOwnerId(),
                providerId: provider.id,
                accountId: account.accountId,
                accountPlanType: account.planType,
                workerId: input.data.workerId,
                trigger: "reset-credit-consumed",
              },
              result.quotaSnapshot,
            );
          } catch {
            request.log.warn(
              {
                event: "provider.quota.reset-persist-failed",
                providerId: provider.id,
                accountId: account.accountId,
                workerId: input.data.workerId,
              },
              "ChatGPT usage reset succeeded but its quota snapshot could not be persisted",
            );
          }
        }
        publishLiveInvalidation("settings");
        return reply.send(result);
      } catch (error) {
        const message = errorMessage(error);
        const authFailure = await sendProviderQuotaAuthenticationFailure(
          reply,
          error,
          {
            providerId: request.params.providerId,
            accountId: request.params.accountId,
          },
        );
        if (authFailure) return authFailure;
        if (message.endsWith("not found.")) {
          return reply.code(404).send({ error: message });
        }
        if (
          message.includes("only available for ChatGPT") ||
          message.includes("not signed in")
        ) {
          return reply.code(409).send({ error: message });
        }
        return sendWorkerRequestFailure(reply, error, message);
      }
    },
  );

  async function accountAuthRunnerAvailable(
    workerId: string | undefined,
  ): Promise<boolean> {
    return Boolean(
      workerId &&
      bridge.isConnected(workerId) &&
      (await repository.getWorker(applicationOwnerId(), workerId)),
    );
  }

  async function prepareProviderAccountSignOut(
    account: Awaited<ReturnType<typeof resolveAccountAuthTarget>>,
    providerId: string,
    requestedWorkerId?: string,
  ): Promise<void> {
    const logoutWorker = (workerId: string) =>
      bridge.request(
        workerId,
        {
          type: "codex.auth.logout",
          providerId,
          providerAccountId: account.accountId,
          providerKind: account.providerKind,
          credentialHomeKey: account.credentialHomeKey,
        },
        { ownerId: applicationOwnerId(), timeoutMs: 15_000 },
      );
    let storedCredential = await repository.getModelProviderAccountCredential(
      applicationOwnerId(),
      providerId,
      account.accountId,
    );
    const legacyWorkers = account.workerBindings
      .filter(({ authState }) => authState === "signed-in")
      .map(({ workerId }) => workerId);
    if (storedCredential) {
      const connectedLegacyWorkers: string[] = [];
      for (const workerId of legacyWorkers) {
        if (await accountAuthRunnerAvailable(workerId)) {
          connectedLegacyWorkers.push(workerId);
        }
      }
      await Promise.allSettled(connectedLegacyWorkers.map(logoutWorker));
      return;
    }

    const boundWorkers = account.workerBindings.map(({ workerId }) => workerId);
    const candidates =
      account.credentialState === "migration-needed"
        ? legacyWorkers
        : [requestedWorkerId, ...legacyWorkers, ...boundWorkers].filter(
            (workerId): workerId is string => Boolean(workerId),
          );
    let runnerId: string | null = null;
    for (const candidate of new Set(candidates)) {
      if (await accountAuthRunnerAvailable(candidate)) {
        runnerId = candidate;
        break;
      }
    }
    if (!runnerId) {
      if (account.credentialState === "migration-needed") {
        throw new ProviderAccountReconnectRequiredError();
      }
      return;
    }

    const capture = await providerCredentialMigrations.captureAccount(
      applicationOwnerId(),
      runnerId,
      providerId,
      account.accountId,
    );
    storedCredential = await repository.getModelProviderAccountCredential(
      applicationOwnerId(),
      providerId,
      account.accountId,
    );
    if (storedCredential) {
      if (capture.workerLogoutRequired) {
        await logoutWorker(runnerId).catch(() => undefined);
      }
      return;
    }

    // Older workers cannot capture portable auth into an endpoint-encrypted
    // envelope. Their normal logout is the only available upstream revocation
    // and local purge path.
    await logoutWorker(runnerId);
  }

  app.get<{
    Querystring: {
      providerId?: string;
      accountId?: string;
      workerId?: string;
    };
  }>("/api/codex/auth/status", async (request, reply) => {
    const { accountId, providerId } = request.query;
    if (!providerId) {
      return reply.code(400).send({ error: "providerId is required" });
    }
    try {
      const [provider, accounts] = await Promise.all([
        repository.getModelProvider(applicationOwnerId(), providerId),
        repository.listModelProviderAccounts(applicationOwnerId(), providerId),
      ]);
      if (!provider || !isAccountProviderKind(provider.kind) || !accounts) {
        throw new Error("Provider account not found.");
      }
      let account = accountId
        ? accounts.find(({ id }) => id === accountId)
        : accounts.find(({ enabled }) => enabled);
      if (!account) throw new Error("Provider account not found.");
      const activeObservation = activeProviderAuthObservation(
        applicationOwnerId(),
        providerId,
        account.id,
      );
      if (activeObservation) {
        const [observationId, active] = activeObservation;
        if (active.expiresAt > Date.now()) {
          return reply.send(
            codexAuthStatusSchema.parse({
              authenticated: false,
              authMode: null,
              email: null,
              planType: null,
              weeklyUsage: null,
              loginPending: true,
              loginError: null,
            }),
          );
        }
        activeProviderAuthObservations.delete(observationId);
        return reply.send(
          codexAuthStatusSchema.parse({
            authenticated: false,
            authMode: null,
            email: null,
            planType: null,
            weeklyUsage: null,
            loginPending: false,
            loginError: "The provider sign-in code expired.",
          }),
        );
      }
      let captureError: string | null = null;
      if (
        account.credentialState !== "signed-in" &&
        request.query.workerId &&
        (await accountAuthRunnerAvailable(request.query.workerId))
      ) {
        const capture = await providerCredentialMigrations.captureAccount(
          applicationOwnerId(),
          request.query.workerId,
          providerId,
          account.id,
        );
        if (capture.malformed > 0) {
          captureError =
            "The worker's provider credential is invalid. Sign in again to replace it.";
        } else if (capture.failed > 0) {
          captureError =
            "The worker could not protect and save provider authentication. Reconnect or update the worker, then try again.";
        }
        const refreshed = await repository.listModelProviderAccounts(
          applicationOwnerId(),
          providerId,
        );
        account = refreshed?.find(({ id }) => id === account!.id) ?? account;
        publishLiveInvalidation("settings");
      }
      const globalStatus = providerAccountAuthStatus(provider.kind, account);
      const status =
        !globalStatus.authenticated && captureError
          ? codexAuthStatusSchema.parse({
              ...globalStatus,
              loginError: captureError,
            })
          : globalStatus;
      if (status.authenticated && request.query.workerId) {
        void loadProviderCatalog(
          applicationOwnerId(),
          providerId,
          request.query.workerId,
          true,
          account.id,
          "account-status-refresh",
        ).catch(() => undefined);
      }
      return reply.send(status);
    } catch (error) {
      const message = errorMessage(error);
      if (message.endsWith("not found.")) {
        return reply.code(404).send({ error: message });
      }
      return sendWorkerRequestFailure(reply, error, message);
    }
  });

  app.post<{
    Body: { providerId?: string; accountId?: string; workerId?: string };
  }>("/api/codex/auth/device-login", async (request, reply) => {
    const { accountId, providerId, workerId } = request.body ?? {};
    if (!workerId || !providerId) {
      return reply
        .code(400)
        .send({ error: "workerId and providerId are required" });
    }
    try {
      const [account, worker] = await Promise.all([
        resolveAccountAuthTarget(providerId, accountId),
        repository.getWorker(applicationOwnerId(), workerId),
      ]);
      if (!worker) throw new Error("Worker not found.");
      removeProviderAuthObservations(
        applicationOwnerId(),
        providerId,
        account.accountId,
      );
      const observationId = randomUUID();
      const startedAt = Date.now();
      const expiresAt = startedAt + 15 * 60_000;
      activeProviderAuthObservations.set(observationId, {
        accountId: account.accountId,
        expiresAt,
        lastSequence: 0,
        ownerId: applicationOwnerId(),
        providerId,
        providerKind: account.providerKind,
        startedAt,
        workerId,
      });
      while (activeProviderAuthObservations.size > 4_096) {
        const oldest = activeProviderAuthObservations.keys().next().value;
        if (oldest === undefined) break;
        activeProviderAuthObservations.delete(oldest);
      }
      let login: ReturnType<typeof codexDeviceLoginSchema.parse>;
      try {
        login = codexDeviceLoginSchema.parse(
          await bridge.request(workerId, {
            type: "codex.auth.login.start",
            providerId,
            providerAccountId: account.accountId,
            providerKind: account.providerKind,
            credentialHomeKey: account.credentialHomeKey,
            observationId,
          }),
        );
      } catch (error) {
        activeProviderAuthObservations.delete(observationId);
        throw error;
      }
      if (activeProviderAuthObservations.has(observationId)) {
        await repository.recordModelProviderAccountStatus(
          account.accountId,
          workerId,
          {
            authenticated: false,
            email: null,
            planType: null,
            weeklyUsage: null,
          },
        );
        publishLiveInvalidation("settings");
        publishProviderAuthStatus({
          providerId,
          providerAccountId: account.accountId,
          providerKind: account.providerKind,
          workerId,
          observedAt: new Date(startedAt).toISOString(),
          expiresAt: new Date(expiresAt).toISOString(),
          status: {
            state: "pending",
            authMode: null,
            email: null,
            planType: null,
            weeklyUsage: null,
            failureCode: null,
          },
        });
      }
      return reply.send(login);
    } catch (error) {
      const message = errorMessage(error);
      if (message.endsWith("not found.")) {
        return reply.code(404).send({ error: message });
      }
      return sendWorkerRequestFailure(reply, error, message);
    }
  });

  app.post<{
    Body: { providerId?: string; accountId?: string; workerId?: string };
  }>("/api/codex/auth/logout", async (request, reply) => {
    const { accountId, providerId, workerId } = request.body ?? {};
    if (!providerId) {
      return reply.code(400).send({ error: "providerId is required" });
    }
    try {
      const account = await resolveAccountAuthTarget(providerId, accountId);
      await prepareProviderAccountSignOut(account, providerId, workerId);
      const signedOut = await providerAccountLifecycle.signOut({
        accountId: account.accountId,
        credentialHomeKey: account.credentialHomeKey,
        kind: account.providerKind,
        ownerId: applicationOwnerId(),
        providerId,
      });
      if (!signedOut) throw new Error("Provider account not found.");
      removeProviderAuthObservations(
        applicationOwnerId(),
        providerId,
        account.accountId,
      );
      publishLiveInvalidation("settings");
      publishProviderAuthStatus({
        providerId,
        providerAccountId: account.accountId,
        providerKind: account.providerKind,
        workerId: workerId ?? "server",
        observedAt: new Date().toISOString(),
        expiresAt: null,
        status: {
          state: "signed-out",
          authMode: null,
          email: null,
          planType: null,
          weeklyUsage: null,
          failureCode: null,
        },
      });
      return reply.code(204).send();
    } catch (error) {
      const message = errorMessage(error);
      if (message.endsWith("not found.")) {
        return reply.code(404).send({ error: message });
      }
      if (error instanceof ProviderAccountReconnectRequiredError) {
        return reply.code(409).send({ error: message });
      }
      return sendWorkerRequestFailure(reply, error, message);
    }
  });
  return {
    prepareProviderAccountSignOut,
    resolveAccountAuthTarget,
  };
}
